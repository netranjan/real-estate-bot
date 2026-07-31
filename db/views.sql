-- ----------------------------
-- 1. crm_leads_view
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

-- ----------------------------
-- 2. crm_appointments_view
-- ----------------------------
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

-- ----------------------------
-- 3. crm_callbacks_view
-- ----------------------------
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