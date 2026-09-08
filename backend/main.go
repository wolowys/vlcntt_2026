package main

import (
	"database/sql"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"
	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
	_ "github.com/lib/pq"
)

type SensorPayload struct {
	Temperature float64 `json:"temperature"`
	Humidity    float64 `json:"humidity"`
	Gas         float64 `json:"gas"`
	Rt          float64 `json:"rt"`
	RiskScore   float64 `json:"riskScore"`
	DhtValid    bool    `json:"dhtValid"`
	Mq2Valid    bool    `json:"mq2Valid"`
	Timestamp   int64   `json:"timestamp"`
}

type SensorRecord struct {
	ID          int64   `json:"id"`
	Temperature float64 `json:"temperature"`
	Humidity    float64 `json:"humidity"`
	Gas         float64 `json:"gas"`
	Rt          float64 `json:"rt"`
	RiskScore   float64 `json:"riskScore"`
	DhtValid    bool    `json:"dhtValid"`
	Mq2Valid    bool    `json:"mq2Valid"`
	Timestamp   int64   `json:"timestamp"`
	CreatedAt   string  `json:"createdAt"`
}

type CommandPayload struct {
	Cmd string `json:"cmd"`
}

var db *sql.DB
var mqttClient mqtt.Client

func connectDB() {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		dsn = "host=localhost user=postgres password=postgres dbname=sensordb sslmode=disable"
	}

	var err error
	for i := 0; i < 10; i++ {
		db, err = sql.Open("postgres", dsn)
		if err == nil {
			if pingErr := db.Ping(); pingErr == nil {
				log.Println("Connected to PostgreSQL")
				break
			}
		}
		log.Printf("DB not ready, retrying in 3s... (%d/10)", i+1)
		time.Sleep(3 * time.Second)
	}
	if err != nil {
		log.Fatalf("Failed to connect to DB: %v", err)
	}
}

func migrateDB() {
	query := `
	CREATE TABLE IF NOT EXISTS sensor_data (
		id          SERIAL PRIMARY KEY,
		temperature DOUBLE PRECISION NOT NULL,
		humidity    DOUBLE PRECISION NOT NULL,
		gas         DOUBLE PRECISION NOT NULL,
		rt          DOUBLE PRECISION NOT NULL,
		risk_score  DOUBLE PRECISION NOT NULL,
		dht_valid   BOOLEAN NOT NULL,
		mq2_valid   BOOLEAN NOT NULL,
		timestamp   BIGINT NOT NULL,
		created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
	);`
	if _, err := db.Exec(query); err != nil {
		log.Fatalf("Migration failed: %v", err)
	}
	log.Println("Database migrated successfully")
}

func insertSensorData(payload SensorPayload) {
	query := `
	INSERT INTO sensor_data (temperature, humidity, gas, rt, risk_score, dht_valid, mq2_valid, timestamp)
	VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
	RETURNING id`

	var id int64
	err := db.QueryRow(query,
		payload.Temperature,
		payload.Humidity,
		payload.Gas,
		payload.Rt,
		payload.RiskScore,
		payload.DhtValid,
		payload.Mq2Valid,
		payload.Timestamp,
	).Scan(&id)

	if err != nil {
		log.Printf("Failed to insert sensor data: %v", err)
		return
	}
	log.Printf("Saved sensor record id=%d temp=%.1f hum=%.1f gas=%.1f risk=%.1f", id, payload.Temperature, payload.Humidity, payload.Gas, payload.RiskScore)
}

func startMQTTSubscriber() {
	broker := os.Getenv("MQTT_BROKER")
	if broker == "" {
		broker = "tcp://test.mosquitto.org:1883"
	}
	topic := os.Getenv("MQTT_TOPIC")
	if topic == "" {
		topic = "nhom13/telemetry"
	}

	opts := mqtt.NewClientOptions()
	opts.AddBroker(broker)
	opts.SetClientID("sensor-backend-" + strconv.FormatInt(time.Now().UnixNano(), 10))
	opts.SetCleanSession(true)
	opts.SetAutoReconnect(true)
	opts.SetConnectRetryInterval(5 * time.Second)

	opts.OnConnect = func(c mqtt.Client) {
		log.Printf("MQTT connected to %s, subscribing to %s", broker, topic)
		token := c.Subscribe(topic, 1, func(_ mqtt.Client, msg mqtt.Message) {
			var payload SensorPayload
			if err := json.Unmarshal(msg.Payload(), &payload); err != nil {
				log.Printf("MQTT invalid JSON: %v | raw: %s", err, string(msg.Payload()))
				return
			}
			insertSensorData(payload)
		})
		if token.Wait() && token.Error() != nil {
			log.Printf("MQTT subscribe error: %v", token.Error())
		}
	}

	opts.OnConnectionLost = func(_ mqtt.Client, err error) {
		log.Printf("MQTT connection lost: %v, reconnecting...", err)
	}

	mqttClient = mqtt.NewClient(opts)
	token := mqttClient.Connect()
	if token.Wait() && token.Error() != nil {
		log.Printf("MQTT initial connect failed: %v (will retry automatically)", token.Error())
	}
}

func publishCommand(c *gin.Context) {
	var body CommandPayload
	if err := c.ShouldBindJSON(&body); err != nil || body.Cmd == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid body, 'cmd' required"})
		return
	}

	if mqttClient == nil || !mqttClient.IsConnected() {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "MQTT not connected"})
		return
	}

	cmdTopic := os.Getenv("MQTT_CMD_TOPIC")
	if cmdTopic == "" {
		cmdTopic = "nhom13/commands"
	}

	msg := strings.ToUpper(body.Cmd)
	token := mqttClient.Publish(cmdTopic, 1, false, msg)
	token.Wait()
	if token.Error() != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": token.Error().Error()})
		return
	}

	log.Printf("Published command: %s -> %s", cmdTopic, msg)
	c.JSON(http.StatusOK, gin.H{"message": "command sent", "cmd": msg, "topic": cmdTopic})
}

func getLatest(c *gin.Context) {
	query := `
	SELECT id, temperature, humidity, gas, rt, risk_score, dht_valid, mq2_valid, timestamp, created_at
	FROM sensor_data
	ORDER BY id DESC
	LIMIT 1`

	row := db.QueryRow(query)
	var rec SensorRecord
	var createdAt time.Time
	err := row.Scan(
		&rec.ID, &rec.Temperature, &rec.Humidity, &rec.Gas,
		&rec.Rt, &rec.RiskScore, &rec.DhtValid, &rec.Mq2Valid,
		&rec.Timestamp, &createdAt,
	)
	if err == sql.ErrNoRows {
		c.JSON(http.StatusNotFound, gin.H{"error": "No data yet"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	rec.CreatedAt = createdAt.Format(time.RFC3339)
	c.JSON(http.StatusOK, rec)
}

func getHistory(c *gin.Context) {
	limitStr := c.DefaultQuery("limit", "50")
	limit, err := strconv.Atoi(limitStr)
	if err != nil || limit <= 0 {
		limit = 50
	}
	if limit > 500 {
		limit = 500
	}

	query := `
	SELECT id, temperature, humidity, gas, rt, risk_score, dht_valid, mq2_valid, timestamp, created_at
	FROM sensor_data
	ORDER BY id DESC
	LIMIT $1`

	rows, err := db.Query(query, limit)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()

	var records []SensorRecord
	for rows.Next() {
		var rec SensorRecord
		var createdAt time.Time
		if err := rows.Scan(
			&rec.ID, &rec.Temperature, &rec.Humidity, &rec.Gas,
			&rec.Rt, &rec.RiskScore, &rec.DhtValid, &rec.Mq2Valid,
			&rec.Timestamp, &createdAt,
		); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		rec.CreatedAt = createdAt.Format(time.RFC3339)
		records = append(records, rec)
	}

	if records == nil {
		records = []SensorRecord{}
	}

	c.JSON(http.StatusOK, records)
}

func deleteAllData(c *gin.Context) {
	_, err := db.Exec("TRUNCATE TABLE sensor_data RESTART IDENTITY")
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	log.Println("All sensor data deleted")
	c.JSON(http.StatusOK, gin.H{"message": "All data deleted"})
}

func main() {
	connectDB()
	migrateDB()
	startMQTTSubscriber()

	r := gin.Default()

	r.Use(cors.New(cors.Config{
		AllowOrigins:     []string{"*"},
		AllowMethods:     []string{"GET", "POST", "DELETE", "OPTIONS"},
		AllowHeaders:     []string{"Origin", "Content-Type", "Authorization"},
		ExposeHeaders:    []string{"Content-Length"},
		AllowCredentials: false,
		MaxAge:           12 * time.Hour,
	}))

	r.GET("/api/sensor/latest", getLatest)
	r.GET("/api/sensor/history", getHistory)
	r.DELETE("/api/sensor/all", deleteAllData)
	r.POST("/api/command", publishCommand)

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	log.Printf("Server running on :%s", port)
	r.Run(":" + port)
}
