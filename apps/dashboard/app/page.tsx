"use client";

import { Fragment, type FormEvent, useCallback, useEffect, useState } from "react";

type Endpoint = {
  id: string;
  url: string;
  description: string;
  enabled: boolean;
  eventTypes: string[];
  timeoutMs: number;
  retryPolicyJson: string;
};
type Delivery = {
  id: string;
  eventId: string;
  endpointId: string;
  eventType: string;
  status: string;
  attemptCount: number;
  nextAttemptAt: string | null;
  createdAt: string;
};
type Health = { status: string; database: string; outboxPending: number | null };
type CreatedEndpoint = { endpoint: Endpoint; signingSecret: string };
type ApiKeyRecord = {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  current: boolean;
};
type Attempt = {
  id: string;
  attemptNumber: number;
  startedAt: string;
  completedAt: string | null;
  httpStatus: number | null;
  durationMs: number | null;
  responseExcerpt: string | null;
  errorCategory: string | null;
  nextAttemptAt: string | null;
};

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export default function Dashboard() {
  const [apiKey, setApiKey] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [bootstrapToken, setBootstrapToken] = useState("");
  const [tenantName, setTenantName] = useState("");
  const [issuedKey, setIssuedKey] = useState("");
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [keys, setKeys] = useState<ApiKeyRecord[]>([]);
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [selectedDelivery, setSelectedDelivery] = useState("");
  const [newApiKeyName, setNewApiKeyName] = useState("");
  const [issuedApiKey, setIssuedApiKey] = useState("");
  const [health, setHealth] = useState<Health | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [createdSecret, setCreatedSecret] = useState("");
  const [endpointUrl, setEndpointUrl] = useState("");
  const [endpointDescription, setEndpointDescription] = useState("");
  const [eventTypes, setEventTypes] = useState("payment.succeeded");
  const [eventJson, setEventJson] = useState(() =>
    JSON.stringify(
      {
        id: "",
        type: "payment.succeeded",
        occurredAt: new Date().toISOString(),
        data: { orderId: "order_123", amount: 499, currency: "INR" },
      },
      null,
      2,
    ),
  );

  const graph = useCallback(
    async <T,>(query: string, variables?: Record<string, unknown>): Promise<T> => {
      const response = await fetch(`${apiUrl}/graphql`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ query, variables }),
        cache: "no-store",
      });
      const payload = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
      if (!response.ok || payload.errors?.length)
        throw new Error(payload.errors?.[0]?.message ?? `API returned ${response.status}`);
      if (!payload.data) throw new Error("API returned an empty response");
      return payload.data;
    },
    [apiKey],
  );

  const refresh = useCallback(async () => {
    if (!apiKey) return;
    setLoading(true);
    setError("");
    try {
      const [endpointData, deliveryData, healthData, keyData] = await Promise.all([
        graph<{ endpoints: Endpoint[] }>(
          "query Endpoints { endpoints { id url description enabled eventTypes timeoutMs retryPolicyJson } }",
        ),
        graph<{ deliveries: Delivery[] }>(
          "query Deliveries { deliveries { id eventId endpointId eventType status attemptCount nextAttemptAt createdAt } }",
        ),
        graph<{ health: Health }>("query Health { health { status database outboxPending } }"),
        graph<{ apiKeys: ApiKeyRecord[] }>(
          "query ApiKeys { apiKeys { id name prefix scopes createdAt revokedAt lastUsedAt current } }",
        ),
      ]);
      setEndpoints(endpointData.endpoints);
      setDeliveries(deliveryData.deliveries);
      setHealth(healthData.health);
      setKeys(keyData.apiKeys);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load DevPulse data");
    } finally {
      setLoading(false);
    }
  }, [apiKey, graph]);

  useEffect(() => {
    const stored = window.sessionStorage.getItem("devpulse-api-key");
    if (stored) {
      setApiKey(stored);
      setHasKey(true);
    }
  }, []);
  useEffect(() => {
    if (hasKey) void refresh();
  }, [hasKey, refresh]);

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNotice("");
    try {
      const response = await fetch(`${apiUrl}/v1/tenants`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-bootstrap-token": bootstrapToken },
        body: JSON.stringify({ name: tenantName }),
      });
      const result = (await response.json()) as {
        tenantId?: string;
        apiKey?: string;
        error?: { message?: string };
      };
      if (!response.ok || !result.apiKey)
        throw new Error(result.error?.message ?? `API returned ${response.status}`);
      setIssuedKey(result.apiKey);
      setApiKey(result.apiKey);
      window.sessionStorage.setItem("devpulse-api-key", result.apiKey);
      setHasKey(true);
      setNotice("Workspace created. Copy your API key now; DevPulse will not show it again.");
      setBootstrapToken("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Workspace setup failed");
    }
  }

  async function useKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    window.sessionStorage.setItem("devpulse-api-key", apiKey);
    setHasKey(true);
    setIssuedKey("");
    await refresh();
  }

  async function addEndpoint(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNotice("");
    try {
      const types = eventTypes
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      const data = await graph<{ createEndpoint: CreatedEndpoint }>(
        "mutation CreateEndpoint($url: String!, $eventTypes: [String!]!, $description: String) { createEndpoint(url: $url, eventTypes: $eventTypes, description: $description) { signingSecret endpoint { id url description enabled eventTypes timeoutMs retryPolicyJson } } }",
        { url: endpointUrl, eventTypes: types, description: endpointDescription },
      );
      setCreatedSecret(data.createEndpoint.signingSecret);
      setEndpointUrl("");
      setEndpointDescription("");
      setNotice("Endpoint saved. Copy its signing secret now; it is shown once.");
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Endpoint creation failed");
    }
  }

  async function toggleEndpoint(endpoint: Endpoint) {
    setError("");
    try {
      await graph(
        "mutation UpdateEndpoint($id: ID!, $enabled: Boolean!) { updateEndpoint(id: $id, enabled: $enabled) { id enabled } }",
        { id: endpoint.id, enabled: !endpoint.enabled },
      );
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Endpoint update failed");
    }
  }

  async function rotateSecret(endpoint: Endpoint) {
    setError("");
    try {
      const result = await graph<{ rotateEndpointSecret: string }>(
        "mutation Rotate($id: ID!) { rotateEndpointSecret(endpointId: $id) }",
        { id: endpoint.id },
      );
      setCreatedSecret(result.rotateEndpointSecret);
      setNotice(
        "Signing secret rotated. Update the recipient configuration with the new value now.",
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Secret rotation failed");
    }
  }

  async function issueKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    try {
      const result = await graph<{ issueApiKey: { key: string } }>(
        "mutation IssueKey($name: String!) { issueApiKey(name: $name) { key } }",
        { name: newApiKeyName },
      );
      setIssuedApiKey(result.issueApiKey.key);
      setNewApiKeyName("");
      setNotice("API key created. Copy it now; DevPulse will not show it again.");
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "API key creation failed");
    }
  }

  async function revokeKey(key: ApiKeyRecord) {
    if (
      key.current ||
      !window.confirm(`Revoke API key “${key.name}”? This action cannot be undone.`)
    )
      return;
    setError("");
    try {
      await graph("mutation RevokeKey($id: ID!) { revokeApiKey(id: $id) }", { id: key.id });
      setNotice(`API key ${key.prefix} was revoked.`);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "API key revocation failed");
    }
  }

  async function loadAttempts(delivery: Delivery) {
    if (selectedDelivery === delivery.id) {
      setSelectedDelivery("");
      setAttempts([]);
      return;
    }
    setSelectedDelivery(delivery.id);
    setAttempts([]);
    setError("");
    try {
      const result = await graph<{ deliveryAttempts: Attempt[] }>(
        "query Attempts($id: ID!) { deliveryAttempts(deliveryId: $id) { id attemptNumber startedAt completedAt httpStatus durationMs responseExcerpt errorCategory nextAttemptAt } }",
        { id: delivery.id },
      );
      setAttempts(result.deliveryAttempts);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load attempts");
    }
  }

  async function deliveryAction(delivery: Delivery, mode: "retry" | "replay") {
    setError("");
    try {
      const operation = mode === "retry" ? "retryDelivery" : "replayDelivery";
      const result = await graph<Record<string, { deliveryId: string; duplicate: boolean }>>(
        `mutation DeliveryAction($id: ID!, $key: String!) { ${operation}(deliveryId: $id, idempotencyKey: $key) { deliveryId duplicate } }`,
        { id: delivery.id, key: crypto.randomUUID() },
      );
      const newId = result[operation]?.deliveryId;
      setNotice(`${mode === "retry" ? "Retry" : "Replay"} queued${newId ? ` as ${newId}` : ""}.`);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : `${mode} failed`);
    }
  }

  async function ingestEvent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNotice("");
    try {
      const parsed = JSON.parse(eventJson) as Record<string, unknown>;
      if (typeof parsed.id !== "string" || parsed.id.length === 0) parsed.id = crypto.randomUUID();
      const response = await fetch(`${apiUrl}/v1/events`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify(parsed),
      });
      const result = (await response.json()) as {
        eventId?: string;
        deliveryIds?: string[];
        error?: { message?: string };
      };
      if (!response.ok) throw new Error(result.error?.message ?? `API returned ${response.status}`);
      setNotice(
        `Event ${result.eventId} accepted. ${result.deliveryIds?.length ?? 0} deliveries queued.`,
      );
      parsed.id = "";
      setEventJson(JSON.stringify(parsed, null, 2));
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Event ingestion failed");
    }
  }

  function disconnect() {
    window.sessionStorage.removeItem("devpulse-api-key");
    setApiKey("");
    setHasKey(false);
    setEndpoints([]);
    setDeliveries([]);
    setKeys([]);
    setHealth(null);
    setIssuedKey("");
    setNotice("");
  }

  if (!hasKey)
    return (
      <main className="connect-screen">
        <section className="connect-card">
          <div className="brand">
            <span className="brand-mark">dp</span>
            <span>devpulse</span>
          </div>
          <p className="eyebrow">WEBHOOK OPERATIONS</p>
          <h1>Keep every delivery in view.</h1>
          <p className="muted">
            Connect to your DevPulse API to manage destinations, send events, and inspect delivery
            outcomes.
          </p>
          {error && (
            <p className="alert error" role="alert">
              {error}
            </p>
          )}
          {notice && (
            <p className="alert success" role="status">
              {notice}
            </p>
          )}
          {issuedKey && (
            <div className="key-reveal">
              <label htmlFor="new-key">New API key — copy it now</label>
              <div className="inline-field">
                <input id="new-key" readOnly value={issuedKey} />
                <button type="button" onClick={() => void navigator.clipboard.writeText(issuedKey)}>
                  Copy key
                </button>
              </div>
            </div>
          )}
          {!issuedKey && (
            <>
              <form className="stack" onSubmit={connect}>
                <h2>Create a local workspace</h2>
                <label>
                  Workspace name
                  <input
                    required
                    minLength={1}
                    maxLength={160}
                    value={tenantName}
                    onChange={(event) => setTenantName(event.target.value)}
                  />
                </label>
                <label>
                  Bootstrap token
                  <input
                    required
                    type="password"
                    autoComplete="off"
                    value={bootstrapToken}
                    onChange={(event) => setBootstrapToken(event.target.value)}
                  />
                </label>
                <button type="submit">Create workspace</button>
              </form>
              <form className="stack separator" onSubmit={useKey}>
                <h2>Or use an existing API key</h2>
                <label>
                  API key
                  <input
                    required
                    type="password"
                    autoComplete="off"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                  />
                </label>
                <button className="secondary" type="submit">
                  Connect
                </button>
              </form>
            </>
          )}
          <p className="footnote">
            Your API key stays in this browser tab session. Keep it private.
          </p>
        </section>
      </main>
    );

  const succeeded = deliveries.filter((delivery) => delivery.status === "succeeded").length;
  const failures = deliveries.filter((delivery) =>
    ["failed", "dead_lettered"].includes(delivery.status),
  ).length;
  const queued = deliveries.filter((delivery) =>
    ["pending", "processing", "retry_scheduled"].includes(delivery.status),
  ).length;

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">dp</span>
          <span>devpulse</span>
        </div>
        <div className="workspace">
          <span className="avatar">D</span>
          <div>
            <strong>Workspace</strong>
            <small>Webhook operations</small>
          </div>
        </div>
        <nav aria-label="Main navigation">
          <a className="active" href="#overview">
            Overview
          </a>
          <a href="#endpoints">Endpoints</a>
          <a href="#deliveries">Deliveries</a>
        </nav>
        <div className="sidebar-bottom">
          <span className={`health-dot ${health?.database === "ok" ? "" : "offline"}`} />
          {health?.database === "ok" ? "API connected" : "API unavailable"}
          <button className="text-button" onClick={disconnect}>
            Disconnect
          </button>
        </div>
      </aside>
      <section className="main-content">
        <header className="topbar">
          <div>
            <p className="eyebrow">DEVELOPER CONSOLE</p>
            <h1>Overview</h1>
          </div>
          <div className="top-actions">
            <span className="status-chip">
              <span className={`health-dot ${health?.database === "ok" ? "" : "offline"}`} />
              {health?.database === "ok" ? "All systems operational" : "Connection issue"}
            </span>
            <button className="secondary compact" onClick={() => void refresh()} disabled={loading}>
              {loading ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </header>
        {error && (
          <p className="alert error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="alert success" role="status">
            {notice}
          </p>
        )}
        {createdSecret && (
          <div className="secret-banner">
            <div>
              <strong>Endpoint signing secret</strong>
              <p>Save this secret securely. DevPulse will not return it again.</p>
            </div>
            <code>{createdSecret}</code>
            <button
              className="secondary compact"
              onClick={() => void navigator.clipboard.writeText(createdSecret)}
            >
              Copy
            </button>
            <button
              aria-label="Dismiss signing secret"
              className="icon-button"
              onClick={() => setCreatedSecret("")}
            >
              ×
            </button>
          </div>
        )}
        {issuedApiKey && (
          <div className="secret-banner">
            <div>
              <strong>New API key</strong>
              <p>Save this key securely. DevPulse will not return it again.</p>
            </div>
            <code>{issuedApiKey}</code>
            <button
              className="secondary compact"
              onClick={() => void navigator.clipboard.writeText(issuedApiKey)}
            >
              Copy
            </button>
            <button
              aria-label="Dismiss API key"
              className="icon-button"
              onClick={() => setIssuedApiKey("")}
            >
              ×
            </button>
          </div>
        )}
        <div id="overview" className="metrics-grid">
          <Metric
            title="Endpoints"
            value={endpoints.length}
            detail={`${endpoints.filter((endpoint) => endpoint.enabled).length} enabled`}
            icon="↗"
          />
          <Metric
            title="Delivered"
            value={succeeded}
            detail="Successful deliveries"
            icon="✓"
            tone="green"
          />
          <Metric
            title="In flight"
            value={queued}
            detail="Pending or retrying"
            icon="◷"
            tone="blue"
          />
          <Metric
            title="Needs attention"
            value={failures}
            detail="Failed or dead lettered"
            icon="!"
            tone="orange"
          />
        </div>
        <div className="content-grid">
          <section id="endpoints" className="panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">DESTINATIONS</p>
                <h2>Endpoints</h2>
              </div>
              <span className="count-pill">{endpoints.length}</span>
            </div>
            <form className="endpoint-form" onSubmit={addEndpoint}>
              <label>
                Webhook URL
                <input
                  required
                  type="url"
                  placeholder="https://api.example.com/webhooks"
                  value={endpointUrl}
                  onChange={(event) => setEndpointUrl(event.target.value)}
                />
              </label>
              <div className="form-row">
                <label>
                  Description
                  <input
                    maxLength={160}
                    placeholder="Payments service"
                    value={endpointDescription}
                    onChange={(event) => setEndpointDescription(event.target.value)}
                  />
                </label>
                <label>
                  Event types
                  <input
                    placeholder="payment.succeeded, user.created"
                    value={eventTypes}
                    onChange={(event) => setEventTypes(event.target.value)}
                  />
                </label>
              </div>
              <button type="submit">Add endpoint</button>
              <p className="field-hint">
                Production endpoints must use HTTPS. Private destinations are disabled unless
                explicitly enabled for local development.
              </p>
            </form>
            {loading && endpoints.length === 0 ? (
              <p className="empty-state">Loading endpoints…</p>
            ) : endpoints.length === 0 ? (
              <p className="empty-state">
                No endpoints yet. Add a destination to start receiving deliveries.
              </p>
            ) : (
              <div className="endpoint-list">
                {endpoints.map((endpoint) => (
                  <article className="endpoint-row" key={endpoint.id}>
                    <span className={`endpoint-icon ${endpoint.enabled ? "" : "paused"}`}>
                      {endpoint.enabled ? "↗" : "Ⅱ"}
                    </span>
                    <div className="endpoint-main">
                      <strong>{endpoint.description || new URL(endpoint.url).host}</strong>
                      <span>{endpoint.url}</span>
                      <small>
                        {endpoint.eventTypes.length
                          ? endpoint.eventTypes.join(", ")
                          : "All event types"}
                      </small>
                    </div>
                    <span className={`pill ${endpoint.enabled ? "pill-green" : "pill-gray"}`}>
                      {endpoint.enabled ? "Enabled" : "Paused"}
                    </span>
                    <button className="text-button" onClick={() => void toggleEndpoint(endpoint)}>
                      {endpoint.enabled ? "Pause" : "Enable"}
                    </button>
                    <button className="text-button" onClick={() => void rotateSecret(endpoint)}>
                      Rotate secret
                    </button>
                  </article>
                ))}
              </div>
            )}
          </section>
          <section className="panel send-panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">EVENT INTAKE</p>
                <h2>Send a test event</h2>
              </div>
            </div>
            <form className="stack" onSubmit={ingestEvent}>
              <label>
                Webhook event JSON
                <textarea
                  required
                  rows={12}
                  spellCheck={false}
                  value={eventJson}
                  onChange={(event) => setEventJson(event.target.value)}
                />
              </label>
              <button type="submit">Send event</button>
            </form>
            <p className="field-hint">
              A fresh idempotency key is generated for each submission. Acceptance means the event
              and matching delivery jobs were committed to the database.
            </p>
          </section>
        </div>
        <section id="deliveries" className="panel deliveries-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">ACTIVITY</p>
              <h2>Recent deliveries</h2>
            </div>
            <span className="count-pill">{deliveries.length}</span>
          </div>
          {loading && deliveries.length === 0 ? (
            <p className="empty-state">Loading delivery history…</p>
          ) : deliveries.length === 0 ? (
            <p className="empty-state">
              Delivery history will appear here after an event matches an endpoint.
            </p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Event</th>
                    <th>Endpoint</th>
                    <th>Status</th>
                    <th>Attempts</th>
                    <th>Created</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {deliveries.map((delivery) => (
                    <Fragment key={delivery.id}>
                      <tr>
                        <td>
                          <strong>{delivery.eventType}</strong>
                          <small>{delivery.eventId}</small>
                        </td>
                        <td>
                          <code>{delivery.endpointId.slice(0, 8)}…</code>
                        </td>
                        <td>
                          <span
                            className={`pill ${delivery.status === "succeeded" ? "pill-green" : ["failed", "dead_lettered"].includes(delivery.status) ? "pill-orange" : "pill-blue"}`}
                          >
                            {delivery.status.replaceAll("_", " ")}
                          </span>
                        </td>
                        <td>{delivery.attemptCount}</td>
                        <td>{new Date(delivery.createdAt).toLocaleString()}</td>
                        <td>
                          <button
                            className="text-button"
                            onClick={() => void loadAttempts(delivery)}
                          >
                            {selectedDelivery === delivery.id ? "Hide attempts" : "Attempts"}
                          </button>
                          <button
                            className="text-button"
                            disabled={!["failed", "dead_lettered"].includes(delivery.status)}
                            onClick={() => void deliveryAction(delivery, "retry")}
                          >
                            Retry
                          </button>
                          <button
                            className="text-button"
                            onClick={() => void deliveryAction(delivery, "replay")}
                          >
                            Replay
                          </button>
                        </td>
                      </tr>
                      {selectedDelivery === delivery.id && (
                        <tr>
                          <td colSpan={6}>
                            <div className="attempt-list">
                              {attempts.length === 0
                                ? "No attempts recorded yet."
                                : attempts.map((attempt) => (
                                    <div key={attempt.id}>
                                      <strong>Attempt {attempt.attemptNumber}</strong>
                                      <span>
                                        {attempt.httpStatus ??
                                          attempt.errorCategory ??
                                          "in progress"}
                                      </span>
                                      <span>
                                        {attempt.durationMs === null
                                          ? "—"
                                          : `${attempt.durationMs} ms`}
                                      </span>
                                      <small>{attempt.startedAt}</small>
                                    </div>
                                  ))}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <section className="panel keys-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">ACCESS CONTROL</p>
              <h2>API keys</h2>
            </div>
            <span className="count-pill">{keys.filter((key) => !key.revokedAt).length} active</span>
          </div>
          <form className="inline-field key-create" onSubmit={issueKey}>
            <label className="sr-only" htmlFor="key-name">
              New key name
            </label>
            <input
              id="key-name"
              required
              maxLength={100}
              placeholder="e.g. Production backend"
              value={newApiKeyName}
              onChange={(event) => setNewApiKeyName(event.target.value)}
            />
            <button type="submit">Create key</button>
          </form>
          <div className="key-list">
            {keys.map((key) => (
              <article key={key.id}>
                <div>
                  <strong>{key.name}</strong>
                  <small>
                    {key.prefix}… ·{" "}
                    {key.current ? "Current key" : key.revokedAt ? "Revoked" : "Active"}
                  </small>
                </div>
                <button
                  className="text-button"
                  disabled={key.current || Boolean(key.revokedAt)}
                  onClick={() => void revokeKey(key)}
                >
                  {key.current ? "In use" : key.revokedAt ? "Revoked" : "Revoke"}
                </button>
              </article>
            ))}
          </div>
        </section>
        <footer>
          DevPulse · At-least-once delivery semantics · {health?.outboxPending ?? "—"} unpublished
          outbox records
        </footer>
      </section>
    </main>
  );
}

function Metric({
  title,
  value,
  detail,
  icon,
  tone = "",
}: {
  title: string;
  value: number;
  detail: string;
  icon: string;
  tone?: string;
}) {
  return (
    <article className="metric-card">
      <span className={`metric-icon ${tone}`}>{icon}</span>
      <div>
        <span className="metric-title">{title}</span>
        <strong>{value}</strong>
        <small>{detail}</small>
      </div>
    </article>
  );
}
