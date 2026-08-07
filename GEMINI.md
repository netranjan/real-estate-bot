# WhatsApp Flow Engine - Project Instructions

Welcome! This file contains foundational mandates, architectural standards, and team-shared conventions for the WhatsApp Flow Engine project. These instructions are binding for all development, bug-fixing, and feature-extension tasks.

---

## 🎯 Project Overview & Mission

This is a flexible, highly optimized WhatsApp automation engine designed for real-estate lead capture, client assignment, automated scoring, property lists/brochure distribution, site visit scheduling, and manual agent callbacks.

---

## 💻 Tech Stack & System Requirements

- **Runtime:** Node.js `>= 18.0.0`
- **Framework:** Express.js `^4.19.2`
- **Database:** PostgreSQL with pooling via `pg` (`^8.12.0`)
- **UI Engine:** EJS Templates (`^3.1.10`) with `express-ejs-layouts` (`^2.5.1`)
- **WhatsApp Transport:** Direct Meta Cloud API client integration
- **Process Manager:** Nodemon in development (`npm run dev`)

---

## 🗺️ Subdirectory Map & Scoped GEMINI.md Instructions

To keep development clean and modular, localized instructions are split into subdirectory-specific `GEMINI.md` files. Refer to them when working in their respective scopes:

1. **Core Flow Engine Layer:** [`./core/GEMINI.md`](./core/GEMINI.md)
   *Manages message parsing, queue-based loop routing, proxies for lazy parameter resolution, and handler registry.*
2. **Database & Data Access Layer:** [`./db/GEMINI.md`](./db/GEMINI.md)
   *Defines pool management, schema migrations, and the dual Repository (`db/repository.js`) / Queries (`db/queries.js`) layers.*
3. **Services Layer:** [`./services/GEMINI.md`](./services/GEMINI.md)
   *Encapsulates core business services, scoring algorithms, and the Card Template Configuration Registry.*

---

## 🏗️ Architectural Conventions & Standards

### 1. File Naming and Formatting
- **Language:** Standard ES6 JavaScript (CommonJS `require(...)` modules). **Do not use TypeScript.**
- **Formatting:** Use standard ES6 syntax, clear function/variable declarations, and self-contained comments. Avoid using hacks, suppression comments (`// eslint-disable-line`), or reflection patterns.
- **Pathing:** Always resolve relative paths cleanly (`path.join(__dirname, ...)`).

### 2. The Consolidator Engine Pattern
- Avoid splitting flows into multiple nested functions or deep recursions that could cause stack overflows.
- All flows operate under an **iterative queue pattern** in `core/engine.js`.
- Flow actions are driven by `core/handlers.js`, registered in `core/registry.js`, and evaluated dynamically.

### 3. State Management & Lead Context
- A user is represented as a **Lead**. State is tracked in the database via the lead's current node and `context_data` (JSONB).
- Lead context variables are dynamically resolved via deep-cloning and lazy-resolved proxies in `core/context.js`.

### 4. Database Access Division
- **Core Engine:** Must strictly use `db/repository.js` (an organized, clean data-access layer utilizing client connections safely and preventing resource leaks).
- **Admin & Dashboards:** Can use `db/queries.js` or the Repository layer for raw queries and standard view rendering.

### 5. Webhook Security & Environment Configuration
- Always load config from `process.env`.
- Critical environment variables (`DATABASE_URL`, `VERIFY_TOKEN`) are validated synchronously during application startup in `app.js`. If any are missing, the application halts.

---

## 🛠️ Common Developer Workflows

### Running the App
- **Production mode:** `npm start`
- **Development mode:** `npm run dev` (utilizes `nodemon` for automatic reloads)

### Database Seeding
- Seeding templates, clients, and properties is done using the scripts located under `scripts/` or `npm run seed`.
- On startup, the application attempts to automatically execute `db/setup.sql` to initialize tables, indexes, views, and basic seeds if they don't already exist.

---

## 🔬 Engineering Standards & Mandates

- **Empirical Bug Fixes:** When fixing a bug, you must first attempt to reproduce the issue locally or through a script before committing a fix.
- **No Staging/Commits:** Never automatically stage or commit changes unless explicitly instructed by the user. Always display git status and proposed message drafts first.
- **Credential Safety:** Never hardcode secrets or API keys. Always retrieve credentials dynamically from environment variables, client settings, or lead contexts.
