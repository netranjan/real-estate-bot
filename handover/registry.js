// core/registry.js
// Node type registry. Adding a new node type = 1 line here.
// Replaces: engine/state-machine.js lines 3-14 + nodeWaitsForInput() switch.

const handlers = require('./handlers');

// Registry entry: { execute, saveReply?, waitsForInput? }
const REGISTRY = {
  send_message: {
    execute: handlers.sendMessage,
    waitsForInput: false,
  },
  collect_input: {
    execute: handlers.collectInput,
    saveReply: handlers.saveCollectReply,
    waitsForInput: true,
  },
  show_list: {
    execute: handlers.showList,
    waitsForInput: true,
  },
  property_welcome: {
    execute: handlers.propertyWelcome,
    waitsForInput: true,
  },
  send_document: {
    execute: handlers.sendDocument,
    waitsForInput: false,
  },
  book_appointment: {
    execute: handlers.bookAppointment,
    saveReply: handlers.saveVisitReply,
    waitsForInput: true,
  },
  request_callback: {
    execute: handlers.requestCallback,
    waitsForInput: false,
  },
  assign_agent: {
    execute: handlers.assignAgent,
    waitsForInput: false,
  },
  calculate_score: {
    execute: handlers.calculateScore,
    waitsForInput: false,
  },
  end_conversation: {
    execute: handlers.endConversation,
    waitsForInput: false,
  },
};

function getHandler(nodeType) {
  const entry = REGISTRY[nodeType];
  if (!entry) throw new Error(`No handler registered for node type: ${nodeType}`);
  return entry;
}

function nodeWaitsForInput(nodeType, result) {
  // Handler can override at runtime
  if (result && typeof result.wait_for_input === 'boolean') {
    return result.wait_for_input;
  }
  const entry = REGISTRY[nodeType];
  return entry ? !!entry.waitsForInput : true;
}

module.exports = { getHandler, nodeWaitsForInput, REGISTRY };