-- ============================================================
-- COMPLETE SETUP — ONE FILE TO RULE THEM ALL
-- Run this once on every startup. Uses IF NOT EXISTS everywhere.
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

-- [PASS1] Self-describing node types
CREATE TABLE IF NOT EXISTS node_types (
    node_type_code VARCHAR(50) PRIMARY KEY,
    node_type_name VARCHAR(100) NOT NULL,
    description TEXT,
    handler_name VARCHAR(50) NOT NULL,
    waits_for_input BOOLEAN DEFAULT FALSE,
    has_save_reply BOOLEAN DEFAULT FALSE,
    outcomes JSONB DEFAULT '[]',
    builder_meta JSONB DEFAULT '{}',
    config_schema JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
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

-- [PASS1] flow_edges now has outcome_name for natural routing
CREATE TABLE IF NOT EXISTS flow_edges (
    edge_id SERIAL PRIMARY KEY,
    flow_id INTEGER NOT NULL REFERENCES conversation_flows(flow_id) ON DELETE CASCADE,
    from_node_id INTEGER NOT NULL REFERENCES flow_nodes(node_id) ON DELETE CASCADE,
    to_node_id INTEGER NOT NULL REFERENCES flow_nodes(node_id) ON DELETE CASCADE,
    user_input_value VARCHAR(100),
    outcome_name VARCHAR(50),
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

-- [PASS1] Index for outcome-based routing
CREATE INDEX IF NOT EXISTS idx_flow_edges_outcome ON flow_edges(flow_id, from_node_id, outcome_name);

ALTER TABLE properties ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- ----------------------------
-- 7. SEED DATA (Self-Describing Node Types)
-- ----------------------------

INSERT INTO node_types (node_type_code, node_type_name, description, handler_name, waits_for_input, has_save_reply, outcomes, builder_meta) VALUES
  ('collect_input', 'Question', 'Ask user a question with options', 'collectInput', true, true,
   '[{"id":"option_picked","label":"User picks an option","default":true},{"id":"free_text","label":"User types something else"}]',
   '{"icon":"❓","color":"purple","label":"Question","fields":["text","options","field","header","footer"],"add_step_label":"❓ Question"}'),

  ('send_message', 'Message', 'Send a plain text or media message', 'sendMessage', false, false,
   '[{"id":"sent","label":"Message sent","default":true}]',
   '{"icon":"💬","color":"blue","label":"Message","fields":["text","source","media_items","property_asset_type"],"add_step_label":"💬 Message"}'),

  ('show_list', 'Property List', 'Display matching properties from database', 'showList', true, false,
   '[{"id":"selected","label":"User picks a property","default":true},{"id":"no_match","label":"Nothing matches their search"}]',
   '{"icon":"🏠","color":"green","label":"Property List","fields":["text","list_mode","match_dimensions","fallback_node_id","header","footer","button_text"],"add_step_label":"🏠 Property List"}'),

  ('property_welcome', 'Property Welcome', 'Show property details and action buttons', 'propertyWelcome', true, false,
   '[{"id":"button_clicked","label":"User taps a button","default":true}]',
   '{"icon":"🏢","color":"indigo","label":"Welcome","fields":["text","buttons","header","suffix_text","fallback_text"],"add_step_label":"🏢 Welcome"}'),

  ('send_document', 'Send Document', 'Send brochure or PDF', 'sendDocument', false, false,
   '[{"id":"sent","label":"Document sent","default":true},{"id":"not_found","label":"Document not available"}]',
   '{"icon":"📄","color":"orange","label":"Document","fields":["text","source","document_url","property_asset_type","media_items","fallback_text"],"add_step_label":"📄 Document"}'),

  ('book_appointment', 'Book Visit', 'Book a site visit', 'bookAppointment', true, true,
   '[{"id":"slot_picked","label":"User picks a slot","default":true},{"id":"no_slots","label":"No slots available"}]',
   '{"icon":"📅","color":"pink","label":"Book Visit","fields":["text","slot_source","options","header","footer"],"add_step_label":"📅 Book Visit"}'),

  ('request_callback', 'Request Callback', 'Request agent callback', 'requestCallback', false, false,
   '[{"id":"requested","label":"Callback requested","default":true}]',
   '{"icon":"📞","color":"teal","label":"Callback","fields":["text","sla_minutes","assign_to","confirmation_message"],"add_step_label":"📞 Callback"}'),

  ('assign_agent', 'Assign Agent', 'Assign lead to an agent', 'assignAgent', false, false,
   '[{"id":"assigned","label":"Agent assigned","default":true}]',
   '{"icon":"👤","color":"gray","label":"Agent","fields":["text","strategy","agent_id","confirmation_message"],"add_step_label":"👤 Assign Agent"}'),

  ('calculate_score', 'Calculate Score', 'Calculate lead quality score', 'calculateScore', false, false,
   '[{"id":"scored","label":"Score calculated","default":true}]',
   '{"icon":"⭐","color":"yellow","label":"Score","fields":["notify_lead","notify_message"],"add_step_label":"⭐ Score"}'),

  ('end_conversation', 'End Conversation', 'Safely ends the conversation', 'endConversation', false, false,
   '[{"id":"ended","label":"Conversation ended","default":true}]',
   '{"icon":"🛑","color":"red","label":"End","fields":["text"],"add_step_label":"🛑 End"}')
ON CONFLICT (node_type_code) DO UPDATE SET
    node_type_name = EXCLUDED.node_type_name,
    description = EXCLUDED.description,
    handler_name = EXCLUDED.handler_name,
    waits_for_input = EXCLUDED.waits_for_input,
    has_save_reply = EXCLUDED.has_save_reply,
    outcomes = EXCLUDED.outcomes,
    builder_meta = EXCLUDED.builder_meta;

-- ----------------------------
-- 8. VIEWS
-- ----------------------------

CREATE OR REPLACE VIEW crm_leads_view AS
SELECT
    l.lead_id,
    l.client_id,
    CONCAT('LEAD-', l.lead_id) AS lead_display_id,
    l.whatsapp_number,
    l.name AS contact_name,
    l.pipeline_stage AS current_pipeline_stage,
    l.ai_score AS current_ai_score,
    l.created_at AS created_at,
    l.updated_at AS latest_contact_date,
    c.business_name AS client_name,
    a.name AS assigned_agent,
    a.phone AS agent_phone,
    (SELECT la.field_value FROM lead_answers la
     WHERE la.lead_id = l.lead_id AND la.field_name = 'requirement_type'
     LIMIT 1) AS requirement_type,
    (SELECT la.field_value FROM lead_answers la
     WHERE la.lead_id = l.lead_id AND la.field_name = 'configuration'
     LIMIT 1) AS configuration,
    (SELECT la.field_value FROM lead_answers la
     WHERE la.lead_id = l.lead_id AND la.field_name = 'budget_range'
     LIMIT 1) AS budget_range,
    (SELECT p.property_name FROM properties p
     WHERE p.property_id = (l.context_data->>'selected_property_id')::INTEGER
     LIMIT 1) AS selected_project,
    (SELECT la.field_value FROM lead_answers la
     WHERE la.lead_id = l.lead_id AND la.field_name = 'timeline'
     LIMIT 1) AS possession_timeline,
    (SELECT COUNT(*) FROM lead_history lh WHERE lh.lead_id = l.lead_id) AS total_enquiries_count,
    CASE
        WHEN (SELECT COUNT(*) FROM lead_history lh WHERE lh.lead_id = l.lead_id) > 1
        THEN 'Returning / Repeat Lead'
        ELSE 'New Lead'
    END AS contact_type
FROM leads l
LEFT JOIN clients c ON l.client_id = c.client_id
LEFT JOIN agents a ON l.assigned_agent_id = a.agent_id;

CREATE OR REPLACE VIEW crm_appointments_view AS
SELECT
    sv.site_visit_id,
    l.client_id,
    CONCAT('APT-', sv.site_visit_id) AS appointment_display_id,
    l.lead_id,
    CONCAT('LEAD-', l.lead_id) AS lead_display_id,
    l.whatsapp_number,
    l.name AS lead_name,
    p.property_name AS project_location,
    p.google_map_url AS project_map_url,
    vo.option_name AS visit_date_slot,
    sv.status AS booking_status,
    sv.gate_pass_status AS e_gate_pass_status,
    sv.visit_outcome,
    sv.agent_notes,
    a.name AS assigned_advisor,
    a.phone AS advisor_phone,
    sv.created_at,
    sv.updated_at
FROM site_visits sv
JOIN leads l ON sv.lead_id = l.lead_id
LEFT JOIN properties p ON sv.property_id = p.property_id
LEFT JOIN property_visit_options vo ON sv.visit_option_id = vo.visit_option_id
LEFT JOIN agents a ON sv.assigned_agent_id = a.agent_id;

CREATE OR REPLACE VIEW crm_callbacks_view AS
SELECT
    cr.callback_request_id,
    l.client_id,
    CONCAT('CB-', cr.callback_request_id) AS callback_display_id,
    l.lead_id,
    CONCAT('LEAD-', l.lead_id) AS lead_display_id,
    l.whatsapp_number,
    l.name AS lead_name,
    a.name AS assigned_agent,
    cr.status,
    cr.sla_deadline,
    cr.created_at,
    cr.resolved_at,
    CASE
        WHEN cr.status = 'PENDING' AND cr.sla_deadline < NOW() THEN 'OVERDUE'
        WHEN cr.status = 'PENDING' THEN 'WITHIN SLA'
        ELSE 'RESOLVED'
    END AS sla_status
FROM callback_requests cr
JOIN leads l ON cr.lead_id = l.lead_id
LEFT JOIN agents a ON cr.assigned_agent_id = a.agent_id;

-- ============================================================
-- AUTHENTICATION
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
    user_id SERIAL PRIMARY KEY,
    username VARCHAR(100) NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role VARCHAR(20) NOT NULL CHECK (role IN ('super_admin', 'client_user')),
    client_id INTEGER REFERENCES clients(client_id) ON DELETE SET NULL,
    display_name VARCHAR(255),
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create a default Super Admin (password: admin123)
-- You MUST change this password after first login in production!
INSERT INTO users (username, password_hash, role, display_name)
VALUES (
    'admin',
    '$2b$10$u4twKaGnv3bRusxWrsjoI.NcSj/KCgcrfCDVMtILTHMWwFXizCgcy',
    'super_admin',
    'Super Admin'
) ON CONFLICT (username) DO NOTHING;

-- ============================================================
-- SESSION STORE (required by connect-pg-simple)
-- ============================================================
CREATE TABLE IF NOT EXISTS "session" (
  "sid" varchar NOT NULL COLLATE "default",
  "sess" json NOT NULL,
  "expire" timestamp(6) NOT NULL
);

-- Primary key (use DO block to avoid error if already exists)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'session_pkey'
  ) THEN
    ALTER TABLE "session" ADD CONSTRAINT "session_pkey" PRIMARY KEY ("sid");
  END IF;
END
$$;

-- Index on expire for cleanup
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");

ALTER TABLE clients ADD COLUMN IF NOT EXISTS currency_symbol VARCHAR(5) DEFAULT '₹';