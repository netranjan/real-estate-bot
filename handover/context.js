// core/context.js
// Template resolver for node configs. Replaces engine/context-resolver.js.
// Supports: {{var}}, {{object.prop}}, lazy DB loads, price formatting.

const repo = require('../db/repository');
const { formatPrice } = require('../utils/format-price');

// ── SAFE DEEP CLONE (replaces JSON.parse(JSON.stringify(...))) ──
function deepClone(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (obj instanceof Date) return new Date(obj);
  if (Array.isArray(obj)) return obj.map(deepClone);
  const cloned = {};
  for (const [k, v] of Object.entries(obj)) {
    cloned[k] = deepClone(v);
  }
  return cloned;
}

// ── CONTEXT BUILDER ──
async function buildContext(leadId) {
  const bundle = await repo.getLeadContextBundle(leadId);
  if (!bundle) throw new Error(`Lead ${leadId} not found`);

  const { lead, answersMap, context } = bundle;

  const ctx = {
    // Lead basics
    lead_name: lead.name || 'there',
    whatsapp_number: lead.whatsapp_number,
    selected_property_id: context.selected_property_id || null,
    selected_property_name: context.selected_property_name || '',
    selected_agent_id: lead.assigned_agent_id || null,

    // Answers
    requirement_type: answersMap.requirement_type || '',
    configuration: answersMap.configuration || '',
    budget_range: answersMap.budget_range || '',
    timeline: answersMap.timeline || '',
  };

  // ── LAZY PROPERTY RESOLUTION ──
  let _property = null;
  const propertyProxy = new Proxy({}, {
    get: async (_target, prop) => {
      if (!_property && ctx.selected_property_id) {
        _property = await repo.getPropertyById(ctx.selected_property_id);
      }
      if (!_property) return '';

      switch (prop) {
        case 'property_name': return _property.property_name;
        case 'property_location': return _property.location || '';
        case 'property_price': return _property.price_min ? formatPrice(_property.price_min) : '';
        case 'property_price_max': return _property.price_max ? formatPrice(_property.price_max) : '';
        case 'property_possession': {
          if (!_property.possession_date) return 'Ready to Move';
          return new Date(_property.possession_date).toLocaleDateString('en-IN', {
            month: 'short', year: 'numeric',
          });
        }
        case 'property_brochure_url': return _property.brochure_url || '';
        case 'property_configuration': {
          const types = _property.configuration_types;
          return Array.isArray(types) ? types.join(', ') : (types || '');
        }
        default: return _property[prop] || '';
      }
    },
  });

  // ── LAZY AGENT RESOLUTION ──
  let _agent = null;
  const agentProxy = new Proxy({}, {
    get: async (_target, prop) => {
      if (!_agent && ctx.selected_agent_id) {
        _agent = await repo.getAgentById(ctx.selected_agent_id);
      }
      if (!_agent) return '';
      if (prop === 'agent_name') return _agent.name;
      if (prop === 'agent_phone') return _agent.phone || '';
      return _agent[prop] || '';
    },
  });

  return { ctx, propertyProxy, agentProxy };
}

// ── RESOLVE A SINGLE VALUE ──
async function resolveValue(value, context) {
  if (typeof value !== 'string') return value;

  // Match {{key}} or {{object.key}}
  return value.replace(/\{\{(\w+(?:\.\w+)?)\}\}/g, async (match, key) => {
    const [main, sub] = key.split('.');

    // Direct context key
    if (!sub && context.ctx[main] !== undefined) {
      return String(context.ctx[main] ?? '');
    }

    // Property sub-keys (lazy)
    if (main === 'property' || main === 'selected_property') {
      return await context.propertyProxy[sub || main] ?? match;
    }

    // Agent sub-keys (lazy)
    if (main === 'agent') {
      return await context.agentProxy[sub || main] ?? match;
    }

    return match;
  });
}

// ── TRAVERSE AND RESOLVE ENTIRE CONFIG ──
async function resolveConfig(config, leadId) {
  const context = await buildContext(leadId);
  const cloned = deepClone(config);

  async function traverse(obj) {
    if (typeof obj === 'string') {
      // String replacement is sync-looking but we need to await the regex replace
      // Since replace with async callback returns a Promise, we handle it
      const matches = [...obj.matchAll(/\{\{(\w+(?:\.\w+)?)\}\}/g)];
      let result = obj;
      for (const match of matches) {
        const resolved = await resolveValue(match[0], context);
        result = result.replace(match[0], resolved);
      }
      return result;
    }
    if (Array.isArray(obj)) {
      const out = [];
      for (const item of obj) out.push(await traverse(item));
      return out;
    }
    if (obj && typeof obj === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(obj)) {
        out[k] = await traverse(v);
      }
      return out;
    }
    return obj;
  }

  return traverse(cloned);
}

module.exports = { resolveConfig, deepClone };