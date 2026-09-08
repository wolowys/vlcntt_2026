#include <WiFi.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include "DHTesp.h"

const int DHT_PIN = 15;
const int MQ2_PIN = 34;
const int LED_GREEN = 18;
const int LED_YELLOW = 19;
const int LED_RED = 23;
const int BUZZER_PIN = 25;
const int RELAY_PIN = 26;
const int BTN_MUTE = 13;
const int BTN_RESET = 12;
const int BTN_TEST = 14;

LiquidCrystal_I2C lcd(0x27, 16, 2);
DHTesp dhtSensor;

// ================= CẤU HÌNH MẠNG & MQTT =================
const char* ssid = "Wokwi-GUEST";
const char* password = "";
const char* mqttServer = "test.mosquitto.org";
const int mqttPort = 1883;

const char* TOPIC_TELEMETRY = "nhom13/telemetry";
const char* TOPIC_COMMANDS  = "nhom13/commands";

WiFiClient espClient;
PubSubClient mqttClient(espClient);

// Khai báo trước để setupWifiAndMQTT() thấy được hàm callback
void mqttCallback(char* topic, byte* payload, unsigned int length);

unsigned long lastReconnectAttempt = 0;

// ================= BIẾN TOÀN CỤC CỦA FSM =================
enum State { NORMAL, WARNING, DANGER, EMERGENCY, SYSTEM_FAULT };
State currentState = NORMAL;

unsigned long lastSampleTime = 0;
unsigned long lastMqttTime = 0;
bool isMuted = false;
bool isTesting = false;

struct SensorData {
  float temperatureRaw;
  float temperatureFiltered;
  float humidity;
  int gasADC;
  float gasRaw;
  float gasFiltered;
  float rateOfRise;
  float ST;
  float SG;
  float SR;
  float riskScore;
  bool dhtValid;
  bool mq2Valid;
  unsigned long timestamp;
};
SensorData sensorData;

// BIẾN CHO FILTER VÀ RISK ENGINE
const int N = 5;
float tempBuffer[N];
int tempIndex = 0;
int tempCount = 0;
float tempSum = 0.0;

float gasBuffer[N];
int gasIndex = 0;
int gasCount = 0;
float gasSum = 0.0;

float previousFilteredTemp = 0.0;
unsigned long previousTempTime = 0;
bool hasPreviousTemp = false;

const float TEMP_SAFE = 30.0;
const float TEMP_DANGER = 60.0;
const float GAS_SAFE = 0.0;
const float GAS_DANGER = 100.0;
const float RT_SAFE = 0.0;
const float RT_DANGER = 1.5;
const float WT = 0.50;
const float WG = 0.30;
const float WR = 0.20;

float filterTemperature(float newValue) {
  if (tempCount < N) {
    tempBuffer[tempIndex] = newValue;
    tempSum += newValue;
    tempCount++;
    tempIndex = (tempIndex + 1) % N;
  } else {
    tempSum -= tempBuffer[tempIndex];
    tempBuffer[tempIndex] = newValue;
    tempSum += newValue;
    tempIndex = (tempIndex + 1) % N;
  }
  return tempSum / tempCount;
}

float filterGas(float newValue) {
  if (gasCount < N) {
    gasBuffer[gasIndex] = newValue;
    gasSum += newValue;
    gasCount++;
    gasIndex = (gasIndex + 1) % N;
  } else {
    gasSum -= gasBuffer[gasIndex];
    gasBuffer[gasIndex] = newValue;
    gasSum += newValue;
    gasIndex = (gasIndex + 1) % N;
  }
  return gasSum / gasCount;
}

float normalizeRisk(float value, float safeValue, float dangerValue) {
  float result = (value - safeValue) / (dangerValue - safeValue);
  if (result < 0.0) result = 0.0;
  if (result > 1.0) result = 1.0;
  return result;
}

void readSensors() {
  sensorData.timestamp = millis();

  TempAndHumidity dhtData = dhtSensor.getTempAndHumidity();
  sensorData.temperatureRaw = dhtData.temperature;
  sensorData.humidity = dhtData.humidity;
  sensorData.dhtValid = !isnan(sensorData.temperatureRaw) && !isnan(sensorData.humidity);

  sensorData.gasADC = analogRead(MQ2_PIN);
  sensorData.gasRaw = (sensorData.gasADC / 4095.0) * 100.0;
  sensorData.mq2Valid = sensorData.gasADC >= 0 && sensorData.gasADC <= 4095;

  if (sensorData.dhtValid) {
    sensorData.temperatureFiltered = filterTemperature(sensorData.temperatureRaw);
    sensorData.rateOfRise = 0.0;
    unsigned long currentTime = millis();
    if (hasPreviousTemp) {
      float deltaTime = (currentTime - previousTempTime) / 1000.0;
      if (deltaTime > 0.0) {
        sensorData.rateOfRise = (sensorData.temperatureFiltered - previousFilteredTemp) / deltaTime;
      }
    }
    previousFilteredTemp = sensorData.temperatureFiltered;
    previousTempTime = currentTime;
    hasPreviousTemp = true;
  } else {
    sensorData.temperatureFiltered = 0.0;
    sensorData.rateOfRise = 0.0;
    hasPreviousTemp = false;
  }

  if (sensorData.mq2Valid) {
    sensorData.gasFiltered = filterGas(sensorData.gasRaw);
  } else {
    sensorData.gasFiltered = 0.0;
  }
}

void calculateRisk() {
  if (!sensorData.dhtValid || !sensorData.mq2Valid) {
    sensorData.ST = 0.0; sensorData.SG = 0.0; sensorData.SR = 0.0; sensorData.riskScore = 0.0;
    return;
  }
  sensorData.ST = normalizeRisk(sensorData.temperatureFiltered, TEMP_SAFE, TEMP_DANGER);
  sensorData.SG = normalizeRisk(sensorData.gasFiltered, GAS_SAFE, GAS_DANGER);

  float positiveRT = sensorData.rateOfRise;
  if (positiveRT < 0.0) positiveRT = 0.0;
  sensorData.SR = normalizeRisk(positiveRT, RT_SAFE, RT_DANGER);

  sensorData.riskScore = 100.0 * (WT * sensorData.ST + WG * sensorData.SG + WR * sensorData.SR);
  if (sensorData.riskScore < 0.0) sensorData.riskScore = 0.0;
  if (sensorData.riskScore > 100.0) sensorData.riskScore = 100.0;
}

// ================= WIFI & MQTT =================
void setupWifiAndMQTT() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, password, 6);   // channel 6: Wokwi-GUEST kết nối nhanh hơn

  Serial.print("[WIFI] Dang ket noi");
  unsigned long startT = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - startT < 20000) {
    delay(300);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("[WIFI] OK - IP: " + WiFi.localIP().toString());
  } else {
    Serial.println("[WIFI] THAT BAI - se thu lai trong loop()");
  }

  // LUÔN cấu hình MQTT, KHÔNG phụ thuộc WiFi đã lên hay chưa.
  // Đây là lỗi khiến MQTT im lặng ở bản cũ.
  mqttClient.setServer(mqttServer, mqttPort);
  mqttClient.setCallback(mqttCallback);
  mqttClient.setBufferSize(512);   // mặc định 256 byte -> JSON bị cắt, publish thất bại
  mqttClient.setKeepAlive(30);
}

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  String message;
  for (unsigned int i = 0; i < length; i++) message += (char)payload[i];
  Serial.println("[MQTT REC] Topic: " + String(topic) + " | Msg: " + message);

  if (message == "MUTE") isMuted = !isMuted;
  if (message == "TEST") isTesting = !isTesting;
  if (message == "RESET" && (currentState != EMERGENCY && currentState != DANGER)) {
    currentState = NORMAL;
  }
}

void mqttReconnect() {
  if (WiFi.status() != WL_CONNECTED) return;
  if (mqttClient.connected()) return;
  if (millis() - lastReconnectAttempt < 5000) return;   // backoff, tránh spam socket
  lastReconnectAttempt = millis();

  String clientId = "ESP32_Nhom13_" + String((uint32_t)ESP.getEfuseMac(), HEX);
  Serial.println("[MQTT] Dang ket noi broker... id=" + clientId);

  if (mqttClient.connect(clientId.c_str())) {
    Serial.println("[MQTT] Connected!");
    mqttClient.subscribe(TOPIC_COMMANDS);
    Serial.println("[MQTT] Subscribed: " + String(TOPIC_COMMANDS));
  } else {
    // rc: -4 timeout | -3 mat ket noi | -2 khong mo duoc TCP | -1 disconnect | 0..5 loi giao thuc
    Serial.printf("[MQTT] FAIL rc=%d - thu lai sau 5s\n", mqttClient.state());
  }
}

void handleButtons() {
  static bool lastMute = HIGH;
  static bool lastReset = HIGH;
  static bool lastTest = HIGH;

  // ===== MUTE =====
  bool muteNow = digitalRead(BTN_MUTE);
  if (lastMute == HIGH && muteNow == LOW) {
    delay(30);
    if (digitalRead(BTN_MUTE) == LOW) {
      isMuted = !isMuted;
      if (isMuted) Serial.println("[EVENT] MUTE Buzzer");
      else         Serial.println("[EVENT] UNMUTE Buzzer");
    }
  }
  lastMute = muteNow;

  // ===== TEST =====
  bool testNow = digitalRead(BTN_TEST);
  if (lastTest == HIGH && testNow == LOW) {
    delay(30);
    if (digitalRead(BTN_TEST) == LOW) {
      isTesting = !isTesting;
      if (isTesting) Serial.println("[EVENT] TEST Mode ON");
      else           Serial.println("[EVENT] TEST Mode OFF");
    }
  }
  lastTest = testNow;

  // ===== RESET =====
  bool resetNow = digitalRead(BTN_RESET);
  if (lastReset == HIGH && resetNow == LOW) {
    delay(30);
    if (digitalRead(BTN_RESET) == LOW) {
      if (currentState != EMERGENCY && currentState != DANGER) {
        currentState = NORMAL;
        Serial.println("[EVENT] RESET System to NORMAL");
      } else {
        Serial.println("[WARN] RESET tu choi: Moi truong chua an toan!");
      }
    }
  }
  lastReset = resetNow;
}

void updateActuators() {
  digitalWrite(LED_GREEN, LOW); digitalWrite(LED_YELLOW, LOW); digitalWrite(LED_RED, LOW);

  lcd.setCursor(0, 0);
  lcd.printf("T:%.0fC G:%.0f%% R:%.0f ", sensorData.temperatureFiltered, sensorData.gasFiltered, sensorData.riskScore);
  lcd.setCursor(0, 1);

  if (isTesting) {
    digitalWrite(LED_GREEN, HIGH); digitalWrite(LED_YELLOW, HIGH); digitalWrite(LED_RED, HIGH);
    lcd.print("ST: TESTING...  ");
    return;
  }

  switch (currentState) {
    case NORMAL:
      digitalWrite(LED_GREEN, HIGH); digitalWrite(BUZZER_PIN, LOW); digitalWrite(RELAY_PIN, LOW);
      lcd.print("ST: NORMAL      "); break;
    case WARNING:
      digitalWrite(LED_YELLOW, HIGH); digitalWrite(BUZZER_PIN, LOW); digitalWrite(RELAY_PIN, LOW);
      lcd.print("ST: WARNING     "); break;
    case DANGER:
      digitalWrite(LED_RED, HIGH); digitalWrite(BUZZER_PIN, isMuted ? LOW : HIGH); digitalWrite(RELAY_PIN, LOW);
      lcd.print("ST: DANGER      "); break;
    case EMERGENCY:
      digitalWrite(LED_RED, HIGH); digitalWrite(BUZZER_PIN, isMuted ? LOW : HIGH); digitalWrite(RELAY_PIN, HIGH);
      lcd.print("ST: EMERGENCY!  "); break;
    case SYSTEM_FAULT:
      digitalWrite(LED_YELLOW, HIGH); digitalWrite(LED_RED, HIGH); digitalWrite(BUZZER_PIN, LOW); digitalWrite(RELAY_PIN, LOW);
      lcd.print("SYSTEM FAULT!   "); break;
  }
}

void publishTelemetry() {
  StaticJsonDocument<384> doc;   // ArduinoJson v7: doi thanh "JsonDocument doc;"

  const char* stateName[] = { "NORMAL", "WARNING", "DANGER", "EMERGENCY", "SYSTEM_FAULT" };

  doc["temperature"] = sensorData.temperatureFiltered;
  doc["humidity"]    = sensorData.humidity;
  doc["gas"]         = sensorData.gasFiltered;
  doc["rt"]          = sensorData.rateOfRise;
  doc["riskScore"]   = sensorData.riskScore;

  doc["dhtValid"]    = sensorData.dhtValid;
  doc["mq2Valid"]    = sensorData.mq2Valid;

  doc["timestamp"]   = sensorData.timestamp;

  doc["state"]       = currentState;
  doc["stateName"]   = stateName[currentState];

  doc["muted"]       = isMuted;
  doc["buzzer"]      = ((currentState == DANGER || currentState == EMERGENCY) && !isMuted);
  doc["relay"]       = (currentState == EMERGENCY);

  char jsonBuffer[512];
  size_t len = serializeJson(doc, jsonBuffer, sizeof(jsonBuffer));

  bool ok = mqttClient.publish(TOPIC_TELEMETRY, jsonBuffer);
  Serial.printf("[MQTT SEND] %s (%u bytes) %s\n", ok ? "OK" : "FAIL", (unsigned)len, jsonBuffer);
}

void setup() {
  Serial.begin(115200);
  delay(200);

  dhtSensor.setup(DHT_PIN, DHTesp::DHT22);
  lcd.init(); lcd.backlight();

  pinMode(LED_GREEN, OUTPUT); pinMode(LED_YELLOW, OUTPUT); pinMode(LED_RED, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT); pinMode(RELAY_PIN, OUTPUT);
  pinMode(BTN_MUTE, INPUT_PULLUP); pinMode(BTN_RESET, INPUT_PULLUP); pinMode(BTN_TEST, INPUT_PULLUP);

  lcd.setCursor(0, 0); lcd.print("Khoi dong...");
  setupWifiAndMQTT();
  lcd.clear();
}

void loop() {
  // Goi vo dieu kien: ham tu kiem tra WiFi, trang thai va backoff ben trong
  mqttReconnect();
  if (mqttClient.connected()) {
    mqttClient.loop();
  }

  handleButtons();

  unsigned long currentMillis = millis();

  if (currentMillis - lastSampleTime >= 1000) {
    lastSampleTime = currentMillis;

    readSensors();
    calculateRisk();

    float temp = sensorData.temperatureFiltered;
    float gas  = sensorData.gasFiltered;
    float rT   = sensorData.rateOfRise;
    float risk = sensorData.riskScore;
    bool isError = (!sensorData.dhtValid || !sensorData.mq2Valid);

    // FSM
    if (isError) {
      currentState = SYSTEM_FAULT;
    } else {
      if (currentState == NORMAL) {
        if (risk >= 25.0 || temp >= 35.0 || gas >= 25.0) currentState = WARNING;
      } else if (currentState == WARNING) {
        if (risk >= 45.0 || temp >= 40.0 || gas >= 40.0 || rT >= 1.5) currentState = DANGER;
        else if (temp < 33.0 && risk < 20.0 && gas < 20.0) currentState = NORMAL;
      } else if (currentState == DANGER) {
        if ((temp >= 55.0 && gas >= 60.0) || risk >= 70.0 || temp >= 50.0 || gas >= 70.0) {
          currentState = EMERGENCY; isMuted = false;
        }
        else if (temp < 38.0 && risk < 40.0 && gas < 35.0) currentState = WARNING;
      } else if (currentState == EMERGENCY) {
        if (temp < 48.0 && gas < 50.0 && risk < 60.0) currentState = DANGER;
      } else if (currentState == SYSTEM_FAULT) {
        currentState = NORMAL;   // cam bien hoi phuc -> thoat trang thai loi
      }
    }

    const char* stateName[] = { "NORMAL", "WARNING", "DANGER", "EMERGENCY", "SYSTEM_FAULT" };
    Serial.printf("T: %.1fC | H: %.1f%% | Gas: %.1f%% | RT: %.2f | Risk: %.1f | State: %s | MQTT: %d\n",
                  sensorData.temperatureFiltered,
                  sensorData.humidity,
                  sensorData.gasFiltered,
                  sensorData.rateOfRise,
                  sensorData.riskScore,
                  stateName[currentState],
                  mqttClient.connected());

    updateActuators();
  }

  if (currentMillis - lastMqttTime >= 3000) {
    lastMqttTime = currentMillis;
    if (mqttClient.connected()) {
      publishTelemetry();
    } else {
      Serial.println("[MQTT] Chua ket noi - bo qua lan gui nay");
    }
  }
}
