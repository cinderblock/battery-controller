/**
 * Temperature Settings — channel management + HA entity browser
 *
 * Allows users to:
 * - View all temperature channels (1-Wire auto-discovered + HTTP)
 * - Name/rename channels
 * - Set stop limits (over-temp safety cutoffs that halt the test)
 * - Enable/disable channels
 * - Configure Home Assistant connection
 * - Browse HA entities and add as channels
 */

import { useCallback, useEffect, useState } from 'react';
import { api, apiPost, type HaEntity, type TempChannelConfig } from '../api-client.ts';
import { useSession } from '../hooks/useDeviceSession.ts';

interface TempConfigResponse {
  pollIntervalS: number;
  homeAssistant: { baseUrl: string; hasToken: boolean } | null;
  channels: TempChannelConfig[];
}

interface ChannelWithTemp extends TempChannelConfig {
  lastTempC: number | null;
}

export function TemperatureSettings() {
  const { state } = useSession();
  const [channels, setChannels] = useState<ChannelWithTemp[]>([]);
  const [haConfig, setHaConfig] = useState<{ baseUrl: string; hasToken: boolean } | null>(null);
  const [haBaseUrl, setHaBaseUrl] = useState('');
  const [haToken, setHaToken] = useState('');
  const [haTestResult, setHaTestResult] = useState<string | null>(null);
  const [haTesting, setHaTesting] = useState(false);
  const [haEntities, setHaEntities] = useState<HaEntity[] | null>(null);
  const [haLoading, setHaLoading] = useState(false);
  const [editingChannel, setEditingChannel] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editAlertMax, setEditAlertMax] = useState('');

  const loadConfig = useCallback(async () => {
    try {
      const cfg = await api<TempConfigResponse>('/api/temp/config');
      setHaConfig(cfg.homeAssistant);
      if (cfg.homeAssistant) setHaBaseUrl(cfg.homeAssistant.baseUrl);
    } catch (err) {
      console.error('Failed to load temp config:', err);
    }
  }, []);

  const loadChannels = useCallback(async () => {
    try {
      const chs = await api<ChannelWithTemp[]>('/api/temp/channels');
      setChannels(chs);
    } catch (err) {
      console.error('Failed to load channels:', err);
    }
  }, []);

  useEffect(() => {
    loadConfig();
    loadChannels();
  }, [loadConfig, loadChannels]);

  // Update last temps from session state
  useEffect(() => {
    if (state.tempReadings.length === 0) return;
    setChannels(prev =>
      prev.map(ch => {
        const reading = state.tempReadings.find(r => r.channelId === ch.id);
        return reading ? { ...ch, lastTempC: reading.tempC } : ch;
      })
    );
  }, [state.tempReadings]);

  const testHaConnection = async () => {
    setHaTesting(true);
    setHaTestResult(null);
    try {
      const result = await apiPost<{ ok: boolean; error?: string }>('/api/temp/config/ha/test', {
        baseUrl: haBaseUrl,
        token: haToken,
      });
      setHaTestResult(result.ok ? 'Connected successfully' : `Failed: ${result.error}`);
    } catch (err) {
      setHaTestResult(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setHaTesting(false);
    }
  };

  const saveHaConnection = async () => {
    try {
      await api('/api/temp/config/ha', {
        method: 'PUT',
        body: JSON.stringify({ baseUrl: haBaseUrl, token: haToken }),
      });
      setHaConfig({ baseUrl: haBaseUrl, hasToken: true });
      setHaToken('');
      setHaTestResult(null);
    } catch (err) {
      setHaTestResult(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const removeHaConnection = async () => {
    try {
      await api('/api/temp/config/ha', { method: 'DELETE' });
      setHaConfig(null);
      setHaBaseUrl('');
      setHaEntities(null);
    } catch (err) {
      console.error('Failed to remove HA config:', err);
    }
  };

  const browseHaEntities = async () => {
    setHaLoading(true);
    try {
      const entities = await api<HaEntity[]>('/api/temp/ha/entities');
      setHaEntities(entities);
    } catch (err) {
      setHaTestResult(`Failed to fetch entities: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setHaLoading(false);
    }
  };

  const addHaEntity = async (entity: HaEntity) => {
    try {
      await apiPost('/api/temp/channels', {
        sourceType: 'http',
        entityId: entity.entityId,
        name: entity.name,
      });
      await loadChannels();
      // Remove from browse list
      setHaEntities(prev => prev?.filter(e => e.entityId !== entity.entityId) ?? null);
    } catch (err) {
      console.error('Failed to add channel:', err);
    }
  };

  const startEditing = (ch: ChannelWithTemp) => {
    setEditingChannel(ch.id);
    setEditName(ch.name ?? '');
    setEditAlertMax(ch.alertMaxC != null ? String(ch.alertMaxC) : '');
  };

  const saveChannel = async (channelId: string) => {
    try {
      await api(`/api/temp/channels/${encodeURIComponent(channelId)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: editName || null,
          alertMaxC: editAlertMax ? parseFloat(editAlertMax) : null,
        }),
      });
      setEditingChannel(null);
      await loadChannels();
    } catch (err) {
      console.error('Failed to save channel:', err);
    }
  };

  const toggleChannel = async (ch: ChannelWithTemp) => {
    try {
      await api(`/api/temp/channels/${encodeURIComponent(ch.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !ch.enabled }),
      });
      await loadChannels();
    } catch (err) {
      console.error('Failed to toggle channel:', err);
    }
  };

  const deleteChannel = async (ch: ChannelWithTemp) => {
    if (!confirm(`Delete channel "${ch.name ?? ch.id}"?`)) return;
    try {
      await api(`/api/temp/channels/${encodeURIComponent(ch.id)}`, { method: 'DELETE' });
      await loadChannels();
    } catch (err) {
      console.error('Failed to delete channel:', err);
    }
  };

  return (
    <div className="temp-settings">
      <header className="temp-settings-header">
        <a
          href="/"
          onClick={e => {
            e.preventDefault();
            window.history.pushState({}, '', '/');
            window.dispatchEvent(new PopStateEvent('popstate'));
          }}
        >
          &larr; Back
        </a>
        <h1>Temperature Sensors</h1>
      </header>

      {/* Channel list */}
      <section className="temp-section">
        <h2>Channels</h2>
        <p className="temp-section-hint">
          A channel's stop limit is a safety cutoff, not a notification: exceeding it immediately stops the running test
          and aborts any running sequence.
        </p>
        {channels.length === 0 && (
          <p className="temp-empty">
            No channels configured. Connect 1-Wire sensors or add Home Assistant entities below.
          </p>
        )}
        <div className="temp-channel-list">
          {channels.map(ch => (
            <div
              key={ch.id}
              className={`temp-channel-card ${!ch.enabled ? 'disabled' : ''} ${ch.unpluggedAt ? 'unplugged' : ''}`}
            >
              {editingChannel === ch.id ? (
                <div className="temp-channel-edit">
                  <input
                    type="text"
                    value={editName}
                    onChange={e => setEditName(e.target.value)}
                    placeholder="Channel name"
                    autoFocus
                  />
                  <input
                    type="number"
                    value={editAlertMax}
                    onChange={e => setEditAlertMax(e.target.value)}
                    placeholder="Stop limit (°C) — halts the test"
                    step="0.5"
                  />
                  <div className="temp-channel-edit-actions">
                    <button onClick={() => saveChannel(ch.id)}>Save</button>
                    <button onClick={() => setEditingChannel(null)}>Cancel</button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="temp-channel-info">
                    <span className="temp-channel-name">{ch.name ?? <em>{ch.id.slice(-6)}</em>}</span>
                    <span className="temp-channel-source">
                      {ch.sourceType === 'w1' ? '1-Wire' : 'HA'}
                      {ch.unpluggedAt && ' (unplugged)'}
                    </span>
                  </div>
                  <div className="temp-channel-reading">
                    {ch.lastTempC != null ? `${ch.lastTempC.toFixed(1)}°C` : '—'}
                  </div>
                  {ch.alertMaxC != null && <div className="temp-channel-alert">Stops at {ch.alertMaxC}°C</div>}
                  <div className="temp-channel-actions">
                    <button onClick={() => startEditing(ch)}>Edit</button>
                    <button onClick={() => toggleChannel(ch)}>{ch.enabled ? 'Disable' : 'Enable'}</button>
                    {ch.sourceType === 'http' && (
                      <button onClick={() => deleteChannel(ch)} className="btn-danger">
                        Delete
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* Home Assistant connection */}
      <section className="temp-section">
        <h2>Home Assistant</h2>
        {haConfig ? (
          <div className="temp-ha-status">
            <span>
              Connected to: <strong>{haConfig.baseUrl}</strong>
            </span>
            <button onClick={browseHaEntities} disabled={haLoading}>
              {haLoading ? 'Loading...' : 'Browse Entities'}
            </button>
            <button onClick={removeHaConnection} className="btn-danger">
              Disconnect
            </button>
          </div>
        ) : (
          <div className="temp-ha-form">
            <label>
              Base URL
              <input
                type="url"
                value={haBaseUrl}
                onChange={e => setHaBaseUrl(e.target.value)}
                placeholder="http://homeassistant.local:8123"
              />
            </label>
            <label>
              Long-lived Access Token
              <input
                type="password"
                value={haToken}
                onChange={e => setHaToken(e.target.value)}
                placeholder="eyJ0eXAiOi..."
              />
            </label>
            <div className="temp-ha-form-actions">
              <button onClick={testHaConnection} disabled={haTesting || !haBaseUrl || !haToken}>
                {haTesting ? 'Testing...' : 'Test Connection'}
              </button>
              <button onClick={saveHaConnection} disabled={!haBaseUrl || !haToken}>
                Save
              </button>
            </div>
            {haTestResult && (
              <p className={`temp-ha-result ${haTestResult.startsWith('Connected') ? 'success' : 'error'}`}>
                {haTestResult}
              </p>
            )}
          </div>
        )}

        {/* HA entity browser */}
        {haEntities && (
          <div className="temp-ha-entities">
            <h3>Temperature Entities ({haEntities.length})</h3>
            {haEntities.length === 0 && <p>No temperature entities found.</p>}
            <div className="temp-entity-list">
              {haEntities.map(e => (
                <div key={e.entityId} className="temp-entity-row">
                  <span className="temp-entity-name">{e.name}</span>
                  <span className="temp-entity-value">
                    {e.state}
                    {e.unit ? ` ${e.unit}` : ''}
                  </span>
                  <span className="temp-entity-id">{e.entityId}</span>
                  <button onClick={() => addHaEntity(e)}>Add</button>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
