CREATE TABLE tenants (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  key_prefix text NOT NULL,
  key_hash char(64) NOT NULL UNIQUE,
  scopes text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  last_used_at timestamptz,
  UNIQUE (tenant_id, id)
);
CREATE INDEX api_keys_tenant_active_idx ON api_keys(tenant_id, created_at DESC) WHERE revoked_at IS NULL;
CREATE INDEX api_keys_prefix_active_idx ON api_keys(key_prefix) WHERE revoked_at IS NULL;

CREATE TABLE endpoints (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  url text NOT NULL CHECK (length(url) <= 2048),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 160),
  enabled boolean NOT NULL DEFAULT true,
  event_types text[] NOT NULL,
  timeout_ms integer NOT NULL DEFAULT 10000 CHECK (timeout_ms BETWEEN 100 AND 30000),
  retry_policy jsonb NOT NULL,
  signing_secret_ciphertext text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (tenant_id, id)
);
CREATE INDEX endpoints_tenant_active_idx ON endpoints(tenant_id, created_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE events (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  event_type text NOT NULL,
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX events_tenant_created_idx ON events(tenant_id, created_at DESC, id DESC);

CREATE TABLE idempotency_records (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  request_hash char(64) NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, idempotency_key)
);
CREATE INDEX idempotency_expiry_idx ON idempotency_records(expires_at);

CREATE TABLE deliveries (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  event_id uuid NOT NULL,
  endpoint_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','processing','succeeded','retry_scheduled','failed','dead_lettered')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz,
  last_enqueued_at timestamptz,
  lease_expires_at timestamptz,
  replay_of uuid REFERENCES deliveries(id),
  replay_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, replay_key),
  FOREIGN KEY (tenant_id, event_id) REFERENCES events(tenant_id, id),
  FOREIGN KEY (tenant_id, endpoint_id) REFERENCES endpoints(tenant_id, id),
  FOREIGN KEY (tenant_id, replay_of) REFERENCES deliveries(tenant_id, id)
);
CREATE INDEX deliveries_tenant_created_idx ON deliveries(tenant_id, created_at DESC, id DESC);
CREATE INDEX deliveries_ready_idx ON deliveries(next_attempt_at, created_at) WHERE status IN ('pending','retry_scheduled');
CREATE INDEX deliveries_expired_lease_idx ON deliveries(lease_expires_at) WHERE status = 'processing';

CREATE TABLE delivery_attempts (
  id uuid PRIMARY KEY,
  delivery_id uuid NOT NULL REFERENCES deliveries(id),
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  http_status integer CHECK (http_status BETWEEN 100 AND 599),
  duration_ms integer CHECK (duration_ms >= 0),
  response_excerpt text CHECK (length(response_excerpt) <= 512),
  error_category text CHECK (error_category IN ('http','timeout','network','policy','response_too_large','internal')),
  next_attempt_at timestamptz,
  UNIQUE (delivery_id, attempt_number)
);
CREATE INDEX delivery_attempts_delivery_idx ON delivery_attempts(delivery_id, attempt_number);

CREATE TABLE outbox (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  delivery_id uuid NOT NULL,
  message_type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  publish_attempts integer NOT NULL DEFAULT 0 CHECK (publish_attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_type, delivery_id, available_at),
  FOREIGN KEY (tenant_id, delivery_id) REFERENCES deliveries(tenant_id, id)
);
CREATE INDEX outbox_unpublished_idx ON outbox(available_at, created_at) WHERE published_at IS NULL;

CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  actor_api_key_id uuid REFERENCES api_keys(id),
  action text NOT NULL,
  subject_type text NOT NULL,
  subject_id uuid NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, actor_api_key_id) REFERENCES api_keys(tenant_id, id)
);
CREATE INDEX audit_events_tenant_created_idx ON audit_events(tenant_id, created_at DESC);

CREATE TABLE worker_heartbeats (
  service_name text PRIMARY KEY,
  instance_id uuid NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);