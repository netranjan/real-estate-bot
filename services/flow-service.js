const db = require('../db/queries');

// ═══════════════════════════════════════
// FLOW BUILDER HELPERS
// ═══════════════════════════════════════

async function getFullFlow(flowId) {
    const [flow, nodes, edges] = await Promise.all([
        db.getFlowById(flowId),
        db.getFlowNodes(flowId),
        db.getFlowEdges(flowId)
    ]);

    if (!flow) return null;

    // Attach edges to each node
    const nodeMap = {};
    nodes.forEach(n => {
        n.connections = [];
        nodeMap[n.node_id] = n;
    });

    edges.forEach(e => {
        if (nodeMap[e.from_node_id]) {
            nodeMap[e.from_node_id].connections.push({
                edgeId: e.edge_id,
                userInput: e.user_input_value,
                toNodeId: e.to_node_id,
                toNodeName: e.to_name,
                conditionLogic: e.condition_logic
            });
        }
    });

    return { flow, nodes, edges };
}

async function reorderNodes(flowId, orderedNodeIds) {
    // orderedNodeIds is an array of node_id in desired order
    const updates = orderedNodeIds.map((nodeId, index) =>
        db.updateNodeOrder(nodeId, index)
    );
    await Promise.all(updates);
    return getFullFlow(flowId);
}

// ═══════════════════════════════════════
// SIMULATION ENGINE
// ═══════════════════════════════════════

async function simulateStep({ flowId, currentNodeId, userInput, context = {}, answers = {} }) {
    const node = await db.getNodeById(currentNodeId);
    if (!node) {
        return { done: true, message: 'Flow ended (no current node)' };
    }

    const result = {
        done: false,
        nodeId: node.node_id,
        nodeName: node.node_name,
        nodeType: node.node_type,
        message: node.config.text || '(No message)',
        options: [],
        context: { ...context },
        answers: { ...answers },
        actions: []
    };

    // Build options from config
    const opts = node.config.options || node.config.buttons || [];
    result.options = opts.map(o => ({
        label: o.label || o.title || o,
        value: o.value || o.id || o.label || o.title || o
    }));

    // If no user input, just show the current step
    if (!userInput) {
        return result;
    }

    // Find matching edge
    const edges = await db.getEdgesFromNode(currentNodeId);
    let matchedEdge = edges.find(e => e.user_input_value === userInput);

    // Fallback: default edge (no user_input_value)
    if (!matchedEdge) {
        matchedEdge = edges.find(e => !e.user_input_value);
    }

    if (!matchedEdge) {
        result.error = `No connection found for input: "${userInput}"`;
        return result;
    }

    // Execute edge actions
    const action = matchedEdge.condition_logic || {};

    if (action.action === 'save_answer' && action.field) {
        result.answers[action.field] = userInput;
        result.actions.push({ type: 'save_answer', field: action.field, value: userInput });
    }

    if (action.action === 'select_property') {
        const oldPropertyId = result.context.selected_property_id || null;
        const newPropertyId = parseInt(userInput, 10) || action.propertyId;

        if (newPropertyId) {
            result.context.selected_property_id = newPropertyId;
            result.actions.push({
                type: 'select_property',
                oldPropertyId,
                newPropertyId
            });
        }
    }

    if (action.action === 'book_visit') {
        result.actions.push({ type: 'book_visit', propertyId: action.propertyId });
    }

    if (action.action === 'request_callback') {
        result.actions.push({ type: 'request_callback' });
    }

    if (action.action === 'score_lead') {
        result.actions.push({ type: 'score_lead', score: action.score });
    }

    // Move to next node
    const nextNode = await db.getNodeById(matchedEdge.to_node_id);
    if (nextNode) {
        result.nextNodeId = nextNode.node_id;
        result.nextNodeName = nextNode.node_name;
    } else {
        result.done = true;
    }

    return result;
}

async function simulateFullFlow(flowId, startNodeId, scenarioInputs = []) {
    // scenarioInputs: array of strings representing user taps/messages
    const flow = await getFullFlow(flowId);
    if (!flow) throw new Error('Flow not found');

    const log = [];
    let currentNodeId = startNodeId;
    // Fallback: if no start node set, use first node in flow
    if (!currentNodeId && flow.nodes && flow.nodes.length > 0) {
        currentNodeId = flow.nodes[0].node_id;
    }
    let context = {};
    let answers = {};

    // Show first step
    const firstStep = await simulateStep({ flowId, currentNodeId, context, answers });
    log.push({ ...firstStep, step: 0, userInput: null });

    // Process each user input
    for (let i = 0; i < scenarioInputs.length; i++) {
        const input = scenarioInputs[i];
        const step = await simulateStep({
            flowId,
            currentNodeId,
            userInput: input,
            context,
            answers
        });

        log.push({ ...step, step: i + 1, userInput: input });

        if (step.done || !step.nextNodeId) break;

        currentNodeId = step.nextNodeId;
        context = step.context;
        answers = step.answers;

        // Auto-show next step
        const nextStep = await simulateStep({ flowId, currentNodeId, context, answers });
        if (!nextStep.done) {
            log.push({ ...nextStep, step: i + 1, userInput: null });
        }
    }

    return { flow, log };
}

// ═══════════════════════════════════════
// PROPERTY SELECTION WITH HISTORY
// ═══════════════════════════════════════

async function selectPropertyForLead(leadId, propertyId, nodeId) {
    const lead = await db.getLeadById(leadId);
    if (!lead) throw new Error('Lead not found');

    const context = lead.context_data || {};
    const oldPropertyId = context.selected_property_id || null;

    // Log old selection to history if exists
    if (oldPropertyId && oldPropertyId !== propertyId) {
        await db.logPropertySelection(leadId, oldPropertyId, propertyId, nodeId);
    }

    // Update context with new property
    context.selected_property_id = propertyId;
    await db.updateLeadContext(leadId, context);

    // Also save as a lead answer for easy querying
    await db.saveLeadAnswer(leadId, 'selected_property_id', String(propertyId), nodeId);

    return {
        leadId,
        oldPropertyId,
        newPropertyId: propertyId,
        context
    };
}

// ═══════════════════════════════════════
// EDGE ACTION BUILDER
// ═══════════════════════════════════════

function buildEdgeAction(type, config = {}) {
    switch (type) {
        case 'save_answer':
            return { action: 'save_answer', field: config.field };
        case 'select_property':
            return { action: 'select_property' };
        case 'book_visit':
            return { action: 'book_visit' };
        case 'request_callback':
            return { action: 'request_callback' };
        case 'score_lead':
            return { action: 'score_lead', score: config.score };
        case 'assign_agent':
            return { action: 'assign_agent', agentId: config.agentId };
        default:
            return {};
    }
}

// ═══════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════

module.exports = {
    getFullFlow,
    reorderNodes,
    simulateStep,
    simulateFullFlow,
    selectPropertyForLead,
    buildEdgeAction
};