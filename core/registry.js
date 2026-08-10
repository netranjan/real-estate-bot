// core/registry.js
// Self-describing node registry. Loaded from DB at startup.
// Adding a new node type = 1 INSERT into node_types + 1 handler function.
// No edits needed here.

const handlers = require('./handlers');
const db = require('../db/queries');

let REGISTRY = null;
let NODE_TYPES = null;

async function loadRegistry() {
  const rows = await db.getAllNodeTypes();
  REGISTRY = {};
  NODE_TYPES = {};

  for (const row of rows) {
    const handlerFn = handlers[row.handler_name];
    if (!handlerFn) {
      console.warn(`⚠️ Handler "${row.handler_name}" not found for node type "${row.node_type_code}"`);
      continue;
    }

    const entry = {
      execute: handlerFn,
      waitsForInput: row.waits_for_input,
      hasSaveReply: row.has_save_reply,
      outcomes: row.outcomes || [],
      builderMeta: row.builder_meta || {},
    };

    if (row.has_save_reply) {
      // Try common naming patterns: collectInput → saveCollectReply, bookAppointment → saveVisitReply
      let saveFnName = row.handler_name.replace(/Input$/, 'Reply');
      // If the name didn't change (doesn't end with 'Input') OR the result is the execute handler itself,
      // skip to the next pattern
      if (saveFnName === row.handler_name || !handlers[saveFnName]) {
        saveFnName = `save${capitalize(row.handler_name)}Reply`;
      }
      if (!handlers[saveFnName]) {
        // Special case mappings
        const mapping = {
          collectInput: 'saveCollectReply',
          bookAppointment: 'saveVisitReply',
          showList: 'saveShowListReply',
        };
        saveFnName = mapping[row.handler_name];
      }
      entry.saveReply = handlers[saveFnName];
      if (!entry.saveReply) {
        console.warn(`⚠️ Save reply handler not found for ${row.node_type_code} (tried: ${saveFnName})`);
      }
    }

    REGISTRY[row.node_type_code] = entry;
    NODE_TYPES[row.node_type_code] = row;
  }

  console.log(`✅ Registry loaded: ${Object.keys(REGISTRY).length} node types`);
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function getHandler(nodeType) {
  const entry = REGISTRY[nodeType];
  if (!entry) throw new Error(`No handler registered for node type: ${nodeType}`);
  return entry;
}

function getNodeMeta(nodeType) {
  return NODE_TYPES[nodeType] || null;
}

function getOutcomes(nodeType) {
  return NODE_TYPES[nodeType]?.outcomes || [];
}

function nodeWaitsForInput(nodeType, result) {
  if (result && typeof result.wait_for_input === 'boolean') {
    return result.wait_for_input;
  }
  const entry = REGISTRY[nodeType];
  return entry ? !!entry.waitsForInput : true;
}

function listNodeTypes() {
  return Object.values(NODE_TYPES);
}

module.exports = {
  loadRegistry,
  getHandler,
  getNodeMeta,
  getOutcomes,
  nodeWaitsForInput,
  listNodeTypes,
  REGISTRY: () => REGISTRY,
};