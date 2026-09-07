# Sensor Monitoring Dashboard

## Tech Stack

| Layer | Technology |
|-------|------------|
| Backend | Go 1.21 + Gin framework |
| Frontend | React 18 + Recharts |
| Database | PostgreSQL 16 |
| Messaging | MQTT (test.mosquitto.org) |
| Container | Docker Compose |

## Getting Started

```bash
sudo docker compose up --build -d
```

| Service | URL |
|---------|-----|
| Frontend | http://localhost:3000 |
| Backend API | http://localhost:8080 |
| PostgreSQL | localhost:5432 |

## Architecture

```
ESP32 (Wokwi)
  │  publish JSON
  ▼
nhom13/telemetry  ──►  Backend (Go)  ──►  PostgreSQL
                                │
nhom13/command   ◄──────────────┘
  │
  ▼
ESP32 receives MUTE / UNMUTE / RESET
```

- ESP32 **publishes** telemetry to topic `nhom13/telemetry`
- Backend **subscribes** to that topic, parses JSON and saves to DB
- Dashboard **sends commands** via backend → topic `nhom13/command`
- ESP32 **subscribes** to `nhom13/command` and handles commands

## MQTT Topics

| Topic | Direction | Description |
|-------|-----------|-------------|
| `nhom13/telemetry` | ESP32 → Backend | Sensor data |
| `nhom13/command` | Backend → ESP32 | Control commands |

### Telemetry payload (ESP32 publishes)

```json
{
  "temperature": 35.5,
  "humidity": 60.2,
  "gas": 25.3,
  "rt": 1.2,
  "riskScore": 38.0,
  "dhtValid": true,
  "mq2Valid": true,
  "timestamp": 1234567890
}
```

### Manual publish test

```bash
mosquitto_pub -h test.mosquitto.org -t "nhom13/telemetry" \
  -m '{"temperature":35.5,"humidity":60.2,"gas":25.3,"rt":1.2,"riskScore":38.0,"dhtValid":true,"mq2Valid":true,"timestamp":123456}'
```

### Subscribe telemetry from terminal

```bash
mosquitto_sub -h test.mosquitto.org -t "nhom13/telemetry"
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/sensor/latest` | Get the latest sensor record |
| GET | `/api/sensor/history?limit=50` | Get history (max 500) |
| DELETE | `/api/sensor/all` | Delete all data |
| POST | `/api/command` | Send a command to ESP32 via MQTT |

### POST /api/command

```bash
curl -X POST http://localhost:8080/api/command \
  -H "Content-Type: application/json" \
  -d '{"cmd": "mute"}'
```

| cmd | MQTT message | Effect |
|-----|-------------|--------|
| `mute` | `MUTE` | Silence the ESP32 buzzer |
| `unmute` | `UNMUTE` | Re-enable the buzzer |
| `reset` | `RESET` | Restart the ESP32 |

## Dashboard UI

- **Live** — data auto-refreshes every 10 seconds
- **Risk bar** — visual indicator from 0–100
- **Alert banner** — automatic DANGER / EMERGENCY notification
- **History** — filterable table of past sensor records
- **🔇 Mute** — silence the ESP32 buzzer remotely
- **🔄 Reset ESP** — restart the ESP32 remotely
- **🗑 Delete Data** — wipe all data from the database

## Alert Thresholds

| Level | Condition | Risk Score |
|-------|-----------|------------|
| LOW | Normal | < 40 |
| MEDIUM | Caution | 40–44 |
| DANGER | Warning | 45–69 |
| EMERGENCY | Critical | ≥ 70 |

> EMERGENCY triggers when: temperature ≥ 50°C, gas ≥ 70 ppm, or riskScore ≥ 70
