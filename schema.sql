-- ============================================================
-- CLEAN SCHEMA — SAFE TO RUN ON EVERY STARTUP
-- Uses IF NOT EXISTS everywhere. No DROP statements.
-- ============================================================

-- ----------------------------
-- 1. CORE IDENTITY & MULTI-TENANCY
-- ----------------------------

CREATE TABLE IF NOT EXISTS clients (
    client_id SERIAL PRIMARY KEY,
    business_name VARCHAR(255) NOT NULL,
    meta_waba_id VARCHAR(100),
    meta_phone_number_id VARCHAR(100),
    meta_access_token TEXT,
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agents (
    agent_id SERIAL PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(client_id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(50),
    email VARCHAR(255),
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ----------------------------
-- 2. FLOW ENGINE
-- ----------------------------

CREATE TABLE IF NOT EXISTS node_types (
    node_type_code VARCHAR(50) PRIMARY KEY,
    node_type_name VARCHAR(100) NOT NULL,
    description TEXT,
    config_schema JSONB DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS conversation_flows (
    flow_id SERIAL PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(client_id) ON DELETE CASCADE,
    flow_name VARCHAR(100) NOT NULL,
    flow_version INTEGER DEFAULT 1,
    is_active BOOLEAN DEFAULT TRUE,
    start_node_id INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS flow_nodes (
    node_id SERIAL PRIMARY KEY,
    flow_id INTEGER NOT NULL REFERENCES conversation_flows(flow_id) ON DELETE CASCADE,
    node_code VARCHAR(50) NOT NULL,
    node_type VARCHAR(50) NOT NULL REFERENCES node_types(node_type_code),
    node_name VARCHAR(100),
    config JSONB NOT NULL DEFAULT '{}',
    order_index INTEGER DEFAULT 0,
    active BOOLEAN DEFAULT TRUE,
    UNIQUE(flow_id, node_code)
);

-- Add self-referencing FK now that flow_nodes exists
ALTER TABLE conversation_flows
    DROP CONSTRAINT IF EXISTS fk_start_node;

ALTER TABLE conversation_flows
    ADD CONSTRAINT fk_start_node
    FOREIGN KEY (start_node_id) REFERENCES flow_nodes(node_id)
    ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS flow_edges (
    edge_id SERIAL PRIMARY KEY,
    flow_id INTEGER NOT NULL REFERENCES conversation_flows(flow_id) ON DELETE CASCADE,
    from_node_id INTEGER NOT NULL REFERENCES flow_nodes(node_id) ON DELETE CASCADE,
    to_node_id INTEGER NOT NULL REFERENCES flow_nodes(node_id) ON DELETE CASCADE,
    user_input_value VARCHAR(100),
    condition_logic JSONB DEFAULT '{}',
    priority INTEGER DEFAULT 0,
    active BOOLEAN DEFAULT TRUE
);

-- ----------------------------
-- 3. LEADS & STATE
-- ----------------------------

CREATE TABLE IF NOT EXISTS leads (
    lead_id SERIAL PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(client_id) ON DELETE CASCADE,
    whatsapp_number VARCHAR(50) NOT NULL,
    name VARCHAR(255),
    current_flow_id INTEGER REFERENCES conversation_flows(flow_id) ON DELETE SET NULL,
    current_node_id INTEGER REFERENCES flow_nodes(node_id) ON DELETE SET NULL,
    pipeline_stage VARCHAR(50) DEFAULT 'New Lead',
    assigned_agent_id INTEGER REFERENCES agents(agent_id) ON DELETE SET NULL,
    ai_score INTEGER DEFAULT 0,
    context_data JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(client_id, whatsapp_number)
);

CREATE TABLE IF NOT EXISTS lead_answers (
    answer_id SERIAL PRIMARY KEY,
    lead_id INTEGER NOT NULL REFERENCES leads(lead_id) ON DELETE CASCADE,
    field_name VARCHAR(100) NOT NULL,
    field_value TEXT NOT NULL,
    node_id INTEGER REFERENCES flow_nodes(node_id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(lead_id, field_name)
);

CREATE TABLE IF NOT EXISTS lead_history (
    history_id SERIAL PRIMARY KEY,
    lead_id INTEGER NOT NULL REFERENCES leads(lead_id) ON DELETE CASCADE,
    event_type VARCHAR(50) NOT NULL,
    node_id INTEGER REFERENCES flow_nodes(node_id),
    details JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ----------------------------
-- 4. OPERATIONAL TABLES
-- ----------------------------

CREATE TABLE IF NOT EXISTS properties (
    property_id SERIAL PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(client_id) ON DELETE CASCADE,
    property_name VARCHAR(255) NOT NULL,
    price_min NUMERIC(15,2),
    price_max NUMERIC(15,2),
    configuration_types JSONB,
    possession_date DATE,
    brochure_url VARCHAR(500),
    welcome_message TEXT,
    google_map_url VARCHAR(500),
    referral_code VARCHAR(50) UNIQUE,
    active BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS media_assets (
    media_asset_id SERIAL PRIMARY KEY,
    property_id INTEGER NOT NULL REFERENCES properties(property_id) ON DELETE CASCADE,
    asset_type VARCHAR(20) NOT NULL,
    asset_url VARCHAR(500) NOT NULL,
    asset_name VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS property_visit_options (
    visit_option_id SERIAL PRIMARY KEY,
    property_id INTEGER NOT NULL REFERENCES properties(property_id) ON DELETE CASCADE,
    option_name VARCHAR(100) NOT NULL,
    active BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS site_visits (
    site_visit_id SERIAL PRIMARY KEY,
    lead_id INTEGER NOT NULL REFERENCES leads(lead_id) ON DELETE CASCADE,
    property_id INTEGER REFERENCES properties(property_id),
    visit_option_id INTEGER NOT NULL REFERENCES property_visit_options(visit_option_id),
    assigned_agent_id INTEGER REFERENCES agents(agent_id),
    status VARCHAR(20) DEFAULT 'BOOKED',
    gate_pass_status VARCHAR(20) DEFAULT 'PENDING',
    visit_outcome VARCHAR(50),
    agent_notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS callback_requests (
    callback_request_id SERIAL PRIMARY KEY,
    lead_id INTEGER NOT NULL REFERENCES leads(lead_id) ON DELETE CASCADE,
    assigned_agent_id INTEGER REFERENCES agents(agent_id),
    status VARCHAR(20) DEFAULT 'PENDING',
    sla_deadline TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
);

-- ----------------------------
-- 5. AUTO-HISTORY TRIGGER
-- ----------------------------

CREATE OR REPLACE FUNCTION log_lead_changes()
RETURNS TRIGGER AS $$
BEGIN
    IF (OLD.current_node_id IS DISTINCT FROM NEW.current_node_id) THEN
        INSERT INTO lead_history (lead_id, event_type, node_id, details)
        VALUES (NEW.lead_id, 'NODE_TRANSITION', NEW.current_node_id, jsonb_build_object(
            'from_node', OLD.current_node_id,
            'to_node', NEW.current_node_id
        ));
    END IF;

    IF (OLD.pipeline_stage IS DISTINCT FROM NEW.pipeline_stage) THEN
        INSERT INTO lead_history (lead_id, event_type, node_id, details)
        VALUES (NEW.lead_id, 'PIPELINE_CHANGE', NEW.current_node_id, jsonb_build_object(
            'from_stage', OLD.pipeline_stage,
            'to_stage', NEW.pipeline_stage
        ));
    END IF;

    IF (OLD.assigned_agent_id IS DISTINCT FROM NEW.assigned_agent_id) THEN
        INSERT INTO lead_history (lead_id, event_type, node_id, details)
        VALUES (NEW.lead_id, 'AGENT_ASSIGNED', NEW.current_node_id, jsonb_build_object(
            'from_agent', OLD.assigned_agent_id,
            'to_agent', NEW.assigned_agent_id
        ));
    END IF;

    IF (OLD.ai_score IS DISTINCT FROM NEW.ai_score) THEN
        INSERT INTO lead_history (lead_id, event_type, node_id, details)
        VALUES (NEW.lead_id, 'SCORE_UPDATED', NEW.current_node_id, jsonb_build_object(
            'old_score', OLD.ai_score,
            'new_score', NEW.ai_score
        ));
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_log_lead_changes ON leads;

CREATE TRIGGER trigger_log_lead_changes
AFTER UPDATE ON leads
FOR EACH ROW
EXECUTE FUNCTION log_lead_changes();

-- ----------------------------
-- 6. INDEXES
-- ----------------------------

CREATE INDEX IF NOT EXISTS idx_leads_client ON leads(client_id);
CREATE INDEX IF NOT EXISTS idx_leads_whatsapp ON leads(whatsapp_number);
CREATE INDEX IF NOT EXISTS idx_leads_node ON leads(current_node_id);
CREATE INDEX IF NOT EXISTS idx_lead_history_lead ON lead_history(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_answers_lead ON lead_answers(lead_id);
CREATE INDEX IF NOT EXISTS idx_flow_edges_from ON flow_edges(from_node_id);
CREATE INDEX IF NOT EXISTS idx_lead_answers_field ON lead_answers(field_name, field_value);

ALTER TABLE properties ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();