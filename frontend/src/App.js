import React, { useState, useEffect, useCallback } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend
} from 'recharts';
import './index.css';

const API_BASE = process.env.REACT_APP_API_URL || 'http://localhost:8080';

function getRiskColor(score) {
  if (score >= 70) return { color: '#ef4444', label: 'HIGH', gradient: 'linear-gradient(90deg, #ef4444, #dc2626)' };
  if (score >= 45) return { color: '#f97316', label: 'DANGER', gradient: 'linear-gradient(90deg, #f97316, #ef4444)' };
  if (score >= 40) return { color: '#f59e0b', label: 'MEDIUM', gradient: 'linear-gradient(90deg, #f59e0b, #d97706)' };
  return { color: '#10b981', label: 'LOW', gradient: 'linear-gradient(90deg, #10b981, #059669)' };
}

// Trả về: null | 'DANGER' | 'EMERGENCY'
function getAlertLevel(data) {
  if (!data) return null;
  const { temperature: t, gas: g, riskScore: r } = data;
  // EMERGENCY (ưu tiên cao hơn)
  if (t >= 50 || g >= 70 || (t >= 55 && g >= 60) || r >= 70) return 'EMERGENCY';
  // DANGER
  if (t >= 40 || g >= 40 || r >= 45) return 'DANGER';
  return null;
}

function ValidBadge({ value }) {
  return (
    <span className={`badge ${value ? 'valid' : 'invalid'}`}>
      {value ? '✓ Valid' : '✗ Invalid'}
    </span>
  );
}

function MetricCard({ icon, label, value, unit, sublabel, gradient }) {
  return (
    <div className="metric-card" style={{ '--card-gradient': gradient }}>
      <div className="card-icon">{icon}</div>
      <div className="card-label">{label}</div>
      <div className="card-value">
        {value !== null && value !== undefined ? (
          <>
            {typeof value === 'number' ? value.toFixed(1) : String(value)}
            {unit && <span className="card-unit">{unit}</span>}
          </>
        ) : (
          <span style={{ color: 'var(--text-muted)', fontSize: '18px' }}>—</span>
        )}
      </div>
      {sublabel && <div className="card-sublabel">{sublabel}</div>}
    </div>
  );
}

function HistoryModal({ onClose }) {
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [limit, setLimit] = useState(50);

  const fetchHistory = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/sensor/history?limit=${limit}`);
      if (!res.ok) throw new Error('Failed');
      const data = await res.json();
      setRecords(data);
    } catch {
      setRecords([]);
    } finally {
      setLoading(false);
    }
  }, [limit]);

  useEffect(() => { fetchHistory(); }, [fetchHistory]);

  const getRiskClass = (score) => {
    if (score >= 70) return 'row-risk-high';
    if (score >= 45) return 'row-risk-danger';
    if (score >= 40) return 'row-risk-medium';
    return 'row-risk-low';
  };

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <div>
            <h2>History</h2>
            <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '2px' }}>
              All recorded sensor readings
            </p>
          </div>
          <button className="btn btn-ghost" onClick={onClose}>✕ Close</button>
        </div>
        <div className="modal-body">
          <div className="modal-limit-row">
            <label>Show last:</label>
            <select value={limit} onChange={e => setLimit(Number(e.target.value))}>
              <option value={20}>20 records</option>
              <option value={50}>50 records</option>
              <option value={100}>100 records</option>
              <option value={200}>200 records</option>
              <option value={500}>500 records</option>
            </select>
            <button className="refresh-btn" onClick={fetchHistory}>↻ Refresh</button>
          </div>

          {loading ? (
            <div className="loading-spinner">
              <div className="spinner" />
              <span>Loading history...</span>
            </div>
          ) : records.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">📭</div>
              <p>No data yet</p>
              <span>Send a POST request to /api/sensor to add data</span>
            </div>
          ) : (
            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>#ID</th>
                    <th>Temp (°C)</th>
                    <th>Humidity (%)</th>
                    <th>Gas (ppm)</th>
                    <th>RT</th>
                    <th>Risk Score</th>
                    <th>DHT</th>
                    <th>MQ2</th>
                    <th>Timestamp</th>
                    <th>Received At</th>
                  </tr>
                </thead>
                <tbody>
                  {records.map((r) => (
                    <tr key={r.id}>
                      <td className="highlight">{r.id}</td>
                      <td className="highlight">{r.temperature.toFixed(1)}</td>
                      <td>{r.humidity.toFixed(1)}</td>
                      <td>{r.gas.toFixed(1)}</td>
                      <td>{r.rt.toFixed(1)}</td>
                      <td className={getRiskClass(r.riskScore)}>
                        {r.riskScore.toFixed(1)}
                      </td>
                      <td>
                        <span className={`badge ${r.dhtValid ? 'valid' : 'invalid'}`}>
                          {r.dhtValid ? '✓' : '✗'}
                        </span>
                      </td>
                      <td>
                        <span className={`badge ${r.mq2Valid ? 'valid' : 'invalid'}`}>
                          {r.mq2Valid ? '✓' : '✗'}
                        </span>
                      </td>
                      <td>{r.timestamp}</td>
                      <td>{new Date(r.createdAt).toLocaleString('vi-VN')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const CustomTooltip = ({ active, payload, label }) => {
  if (active && payload && payload.length) {
    return (
      <div style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        borderRadius: '10px',
        padding: '12px 16px',
        fontSize: '13px',
      }}>
        <p style={{ color: 'var(--text-muted)', marginBottom: '8px' }}>ID: {label}</p>
        {payload.map(p => (
          <div key={p.dataKey} style={{ color: p.color, marginBottom: '4px' }}>
            {p.name}: <strong>{Number(p.value).toFixed(1)}</strong>
          </div>
        ))}
      </div>
    );
  }
  return null;
};

export default function App() {
  const [latest, setLatest] = useState(null);
  const [chartData, setChartData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [muted, setMuted] = useState(false);
  const [cmdSending, setCmdSending] = useState(null);

  const fetchLatest = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/sensor/latest`);
      if (!res.ok) throw new Error('Not found');
      const data = await res.json();
      setLatest(data);
      setError(false);
      setLastUpdated(new Date());
    } catch {
      setLatest(null);
      setError(true);
    }
  }, []);

  const fetchChartData = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/sensor/history?limit=20`);
      if (!res.ok) throw new Error('Failed');
      const data = await res.json();
      setChartData([...data].reverse());
    } catch {
      setChartData([]);
    }
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([fetchLatest(), fetchChartData()]);
    setRefreshing(false);
  }, [fetchLatest, fetchChartData]);

  const handleDeleteAll = useCallback(async () => {
    if (!window.confirm('Xóa toàn bộ dữ liệu sensor? Hành động này không thể hoàn tác.')) return;
    setDeleting(true);
    try {
      const res = await fetch(`${API_BASE}/api/sensor/all`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
      setLatest(null);
      setChartData([]);
      setLastUpdated(null);
    } catch (e) {
      alert('Xóa thất bại: ' + e.message);
    } finally {
      setDeleting(false);
    }
  }, []);

  const sendCommand = useCallback(async (cmd) => {
    setCmdSending(cmd);
    try {
      const res = await fetch(`${API_BASE}/api/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmd }),
      });
      if (!res.ok) throw new Error('Command failed');
      if (cmd === 'mute') setMuted(true);
      if (cmd === 'unmute') setMuted(false);
    } catch (e) {
      alert('Gửi lệnh thất bại: ' + e.message);
    } finally {
      setCmdSending(null);
    }
  }, []);

  useEffect(() => {
    const init = async () => {
      setLoading(true);
      await Promise.all([fetchLatest(), fetchChartData()]);
      setLoading(false);
    };
    init();
    const interval = setInterval(refresh, 10000);
    return () => clearInterval(interval);
  }, [fetchLatest, fetchChartData, refresh]);

  const risk = latest ? getRiskColor(latest.riskScore) : null;
  const alertLevel = latest ? getAlertLevel(latest) : null;

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <div className="header-icon">🌡️</div>
          <div>
            <h1>Sensor Dashboard</h1>
            <div className="header-subtitle">Real-time environmental monitoring</div>
          </div>
        </div>
        <div className="header-right">
          {lastUpdated && (
            <span className="last-updated">
              Updated: {lastUpdated.toLocaleTimeString('vi-VN')}
            </span>
          )}
          <div className={`status-badge ${error ? 'error' : ''}`}>
            <div className={`pulse-dot ${error ? 'red' : ''}`} />
            {error ? 'Offline' : 'Live'}
          </div>
          <button
            className={`refresh-btn ${refreshing ? 'spinning' : ''}`}
            onClick={refresh}
            disabled={refreshing}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M23 4v6h-6M1 20v-6h6" />
              <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
            </svg>
            Refresh
          </button>
          <button
            className="btn btn-primary"
            id="history-btn"
            onClick={() => setShowHistory(true)}
          >
            History
          </button>
          <button
            className={`btn btn-mute ${muted ? 'active' : ''}`}
            id="mute-btn"
            onClick={() => sendCommand(muted ? 'unmute' : 'mute')}
            disabled={cmdSending !== null}
          >
            {cmdSending === 'mute' || cmdSending === 'unmute'
              ? '...'
              : muted ? '🔊 Unmute' : '🔇 Mute'}
          </button>
          <button
            className="btn btn-reset"
            id="reset-btn"
            onClick={() => sendCommand('reset')}
            disabled={cmdSending !== null}
          >
            {cmdSending === 'reset' ? '...' : '🔄 Reset ESP'}
          </button>
          <button
            className="btn btn-danger"
            id="delete-all-btn"
            onClick={handleDeleteAll}
            disabled={deleting}
          >
            {deleting ? 'Deleting...' : '🗑 Delete Data'}
          </button>
        </div>
      </header>

      <main className="content">
        {loading ? (
          <div className="loading-spinner" style={{ height: '60vh' }}>
            <div className="spinner" />
            <span>Loading sensor data...</span>
          </div>
        ) : (
          <>
            {!latest && (
              <div className="no-data-notice">
                ⚠️ No sensor data yet. Publish to MQTT topic{' '}
                <code style={{ background: 'rgba(0,0,0,0.3)', padding: '2px 6px', borderRadius: '4px' }}>
                  nhom13/telemetry
                </code>
              </div>
            )}

            {latest && risk && (
              <div className="risk-bar-container" style={{ marginBottom: '24px' }}>
                <div className="risk-bar-header">
                  <div>
                    <div className="card-label">Risk Score</div>
                    <div className="risk-value-big" style={{ color: risk.color }}>
                      {latest.riskScore.toFixed(1)}
                      <span style={{ fontSize: '18px', fontWeight: 400, color: 'var(--text-muted)', marginLeft: '8px' }}>
                        / 100
                      </span>
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div className={`badge ${latest.riskScore >= 70 ? 'invalid' : latest.riskScore >= 40 ? '' : 'valid'}`}
                      style={latest.riskScore >= 40 && latest.riskScore < 70 ? {
                        background: 'rgba(245,158,11,0.15)',
                        border: '1px solid rgba(245,158,11,0.3)',
                        color: 'var(--accent-orange)',
                        padding: '6px 16px',
                        fontSize: '13px'
                      } : { padding: '6px 16px', fontSize: '13px' }}
                    >
                      {risk.label} RISK
                    </div>
                    <div className="timestamp-info" style={{ justifyContent: 'flex-end', marginTop: '8px' }}>
                      Timestamp: {latest.timestamp}
                    </div>
                  </div>
                </div>
                <div className="risk-bar-track">
                  <div
                    className="risk-bar-fill"
                    style={{
                      width: `${Math.min(latest.riskScore, 100)}%`,
                      background: risk.gradient
                    }}
                  />
                </div>
                <div className="risk-labels">
                  <span>0 — Safe</span>
                  <span>40 — Medium</span>
                  <span>45 — Danger</span>
                  <span>70 — Emergency</span>
                  <span>100</span>
                </div>
              </div>
            )}

            {alertLevel && (
              <div className={`alert-banner alert-${alertLevel.toLowerCase()}`}>
                <span className="alert-icon">{alertLevel === 'EMERGENCY' ? '🚨' : '⚠️'}</span>
                <div className="alert-content">
                  <strong>{alertLevel === 'EMERGENCY' ? '🚨 EMERGENCY — Nguy hiểm nghiêm trọng!' : '⚠️ DANGER — Cảnh báo nguy hiểm!'}</strong>
                  <span>
                    {alertLevel === 'EMERGENCY'
                      ? `Phát hiện điều kiện khẩn cấp: Nhiệt độ ${latest.temperature.toFixed(1)}°C · Khí ${latest.gas.toFixed(1)} · Risk ${latest.riskScore.toFixed(1)}/100`
                      : `Vượt ngưỡng an toàn: Nhiệt độ ${latest.temperature.toFixed(1)}°C · Khí ${latest.gas.toFixed(1)} · Risk ${latest.riskScore.toFixed(1)}/100`
                    }
                  </span>
                </div>
              </div>
            )}

            <div className="section-title">Sensor Readings</div>
            <div className="cards-grid">
              <MetricCard
                icon="🌡️"
                label="Temperature"
                value={latest?.temperature}
                unit="°C"
                sublabel="Ambient temperature"
                gradient="linear-gradient(90deg, #ef4444, #f97316)"
              />
              <MetricCard
                icon="💧"
                label="Humidity"
                value={latest?.humidity}
                unit="%"
                sublabel="Relative humidity"
                gradient="linear-gradient(90deg, #3b82f6, #06b6d4)"
              />
              <MetricCard
                icon="💨"
                label="Gas"
                value={latest?.gas}
                unit="ppm"
                sublabel="Gas concentration"
                gradient="linear-gradient(90deg, #8b5cf6, #6366f1)"
              />
              <MetricCard
                icon="📡"
                label="RT Value"
                value={latest?.rt}
                unit=""
                sublabel="RT sensor output"
                gradient="linear-gradient(90deg, #10b981, #06b6d4)"
              />
              <MetricCard
                icon="🔬"
                label="DHT Sensor"
                value={latest !== null ? (latest.dhtValid ? '✓ Valid' : '✗ Invalid') : null}
                unit=""
                sublabel={latest ? (latest.dhtValid ? 'Sensor OK' : 'Sensor Error') : ''}
                gradient={latest?.dhtValid
                  ? "linear-gradient(90deg, #10b981, #059669)"
                  : "linear-gradient(90deg, #ef4444, #dc2626)"}
              />
              <MetricCard
                icon="🛢️"
                label="MQ2 Sensor"
                value={latest !== null ? (latest.mq2Valid ? '✓ Valid' : '✗ Invalid') : null}
                unit=""
                sublabel={latest ? (latest.mq2Valid ? 'Sensor OK' : 'Sensor Error') : ''}
                gradient={latest?.mq2Valid
                  ? "linear-gradient(90deg, #10b981, #059669)"
                  : "linear-gradient(90deg, #ef4444, #dc2626)"}
              />
            </div>

            {chartData.length > 1 && (
              <>
                <div className="section-title">Trend — Last 20 Readings</div>
                <div className="chart-section">
                  <h3>Temperature, Humidity & Gas over time</h3>
                  <ResponsiveContainer width="100%" height={280}>
                    <LineChart data={chartData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                      <XAxis
                        dataKey="id"
                        stroke="var(--text-muted)"
                        tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
                        label={{ value: 'Record ID', position: 'insideBottom', offset: -2, fill: 'var(--text-muted)', fontSize: 11 }}
                      />
                      <YAxis stroke="var(--text-muted)" tick={{ fill: 'var(--text-muted)', fontSize: 11 }} />
                      <Tooltip content={<CustomTooltip />} />
                      <Legend
                        wrapperStyle={{ fontSize: '12px', color: 'var(--text-secondary)', paddingTop: '10px' }}
                      />
                      <Line type="monotone" dataKey="temperature" name="Temp (°C)" stroke="#ef4444" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                      <Line type="monotone" dataKey="humidity" name="Humidity (%)" stroke="#3b82f6" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                      <Line type="monotone" dataKey="gas" name="Gas (ppm)" stroke="#8b5cf6" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>

                <div className="chart-section">
                  <h3>Risk Score over time</h3>
                  <ResponsiveContainer width="100%" height={200}>
                    <LineChart data={chartData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                      <XAxis
                        dataKey="id"
                        stroke="var(--text-muted)"
                        tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
                      />
                      <YAxis domain={[0, 100]} stroke="var(--text-muted)" tick={{ fill: 'var(--text-muted)', fontSize: 11 }} />
                      <Tooltip content={<CustomTooltip />} />
                      <Line type="monotone" dataKey="riskScore" name="Risk Score" stroke="#f59e0b" strokeWidth={2.5} dot={false} activeDot={{ r: 4 }} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </>
            )}
          </>
        )}
      </main>

      {showHistory && <HistoryModal onClose={() => setShowHistory(false)} />}
    </div>
  );
}
