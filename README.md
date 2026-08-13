# daraziq.store Backend

Node/Express backend for daraziq.store, a Daraz seller intelligence SaaS with marketplace OAuth, encrypted seller credentials, AI-assisted analytics, competitor browser automation, pricing guardrails, and an MCP server for external AI clients.

This backend is the core product layer. Both the website and MCP clients call the same service functions, so seller analytics, product benchmarking, and pricing logic live once and are exposed through REST and MCP.

## Product Overview

daraziq.store helps Daraz sellers connect their seller account and turn marketplace data into useful actions:

- Secure user authentication with email/password, OTP, Google sign-in, and JWT sessions.
- Daraz Open Platform OAuth connection and disconnect flow.
- Encrypted storage of Daraz access credentials.
- Store KPI snapshots and performance analysis.
- Product and competitor benchmarking.
- Browser automation for competitor product discovery.
- Guardrail-based pricing recommendations and reprice audit logs.
- AI summaries using OpenAI or OpenRouter.
- Remote MCP endpoint for Claude, ChatGPT-compatible agents, and other MCP clients.

## Tech Stack

- Node.js
- Express 5
- PostgreSQL
- Sequelize ORM
- JWT authentication
- Nodemailer OTP delivery
- Google Auth Library
- Daraz Open Platform OAuth/API integration
- Playwright browser automation
- Model Context Protocol SDK
- OpenAI-compatible chat completions through OpenAI/OpenRouter

## Architecture

```txt
backend/
  src/
    features/
      auth.js        # Email/password, OTP, Google auth
      daraz.js       # Daraz OAuth, token exchange, account status
      copilot.js     # Store, product, competitor, pricing, AI services + REST routes
      mcp.js         # MCP tools/resources/prompts over Streamable HTTP
      oauth.js       # OAuth server for MCP connector authentication
      settings.js    # AI provider settings
    services/
      competitorScraper.js  # Playwright scraper owned by backend
    config.js
    middleware.js
    models.js
    server.js
    utils.js
```

## Core API Areas

### Authentication

- Register and verify email.
- Login with email/password.
- Request and verify OTP through Nodemailer.
- Sign in with Google Identity Services.
- Return a signed JWT session used by the frontend.

Main route group:

```txt
/api/auth
```

### Daraz Integration

- Creates Daraz OAuth authorization URLs.
- Handles the Daraz callback.
- Exchanges authorization codes for seller access tokens.
- Encrypts token data before saving it in PostgreSQL.
- Supports disconnecting the Daraz account.
- Returns reconnect states when stored Daraz credentials are invalid or expired.

Main route group:

```txt
/api/daraz
```

### Copilot Services

The Copilot service layer powers both REST and MCP:

- Store metrics
- Store history
- Store performance analysis
- Own product lookup
- Competitor search
- Product analysis
- Anomaly detection
- Pricing guardrails
- Price recommendations
- Reprice audit trail
- AI business brief

Main route group:

```txt
/api/copilot
```

### Browser Automation

The Playwright scraper now lives inside the backend:

```txt
src/services/competitorScraper.js
```

It can load Daraz search result pages, scroll lazy-loaded product cards, parse product titles, prices, sales counts, reviews, images, and URLs, then normalize the data for competitor benchmarking.

Live scraping is controlled by env flags:

```env
COMPETITOR_LIVE_SCRAPE_ENABLED=false
COMPETITOR_SCRAPE_MAX_PAGES=1
```

When live scraping is disabled or unavailable, competitor results return a clean empty state with a warning. No dummy competitor products are served in production.

### MCP Server

The backend exposes a remote MCP endpoint:

```txt
POST /api/mcp
```

It supports OAuth-based authentication for MCP clients. Claude or another MCP client does not guess the user identity; it receives an OAuth access token issued by this backend. The token subject maps to the daraziq.store user id, and every MCP tool runs against that authenticated seller.

Available MCP tools include:

- `get_store_metrics`
- `get_metrics_history`
- `analyze_store_performance`
- `get_own_product`
- `search_competitors`
- `analyze_product`
- `flag_anomalies`
- `analyze_price`
- `apply_reprice`
- `get_reprice_history`

OAuth discovery endpoints:

```txt
/.well-known/oauth-protected-resource/api/mcp
/.well-known/oauth-authorization-server
/.well-known/openid-configuration
```

### AI Provider Layer

The backend can use:

- OpenAI
- OpenRouter

Users can switch provider settings from the frontend. API keys can come from platform env variables or user-level encrypted settings.

## Database

The backend uses Sequelize models for:

- Users
- Email verification codes
- OTP codes
- Daraz connections
- Store snapshots
- Product snapshots
- Competitor snapshots
- Guardrail configs
- Reprice logs
- AI provider settings
- OAuth clients
- OAuth authorization codes
- OAuth refresh tokens

PostgreSQL is used in local development and production. Neon Postgres works well for deployment.

## Environment Variables

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Important production variables:

```env
NODE_ENV=production
PORT=4000
API_BASE_URL=https://your-backend-domain.com
FRONTEND_URL=https://daraziq.store
JWT_SECRET=generate-a-long-random-value
OAUTH_STATE_SECRET=generate-another-long-random-value
TOKEN_ENCRYPTION_KEY=generate-a-separate-long-random-value

DATABASE_URL=postgresql://user:password@host/database?sslmode=require
DB_SSL=true

DARAZ_APP_KEY=your-daraz-app-key
DARAZ_APP_SECRET=your-daraz-app-secret
DARAZ_REDIRECT_URI=https://your-backend-domain.com/api/daraz/callback

MCP_RESOURCE_URL=https://your-backend-domain.com/api/mcp
OAUTH_ISSUER=https://your-backend-domain.com
MCP_ACCESS_TOKEN_EXPIRES_IN=7d
MCP_REFRESH_TOKEN_EXPIRES_IN=90d
```

For AI:

```env
AI_PROVIDER=openrouter
OPENROUTER_API_KEY=your-openrouter-key
OPENROUTER_MODEL=openrouter/free
OPENROUTER_SITE_URL=https://daraziq.store
OPENROUTER_APP_NAME=daraziq.store
```

or:

```env
AI_PROVIDER=openai
OPENAI_API_KEY=your-openai-key
OPENAI_MODEL=gpt-5.6-terra
```

## Local Development

Install dependencies:

```bash
npm install
```

Run the API:

```bash
npm run dev
```

Health check:

```txt
http://localhost:4000/api/health
```

Run syntax checks:

```bash
npm run check
```

## Playwright Setup

For live scraping, install Chromium:

```bash
npm run install:browsers
```

On production hosts such as Render, use a build command that installs dependencies and the browser binary:

```bash
npm install && npm run install:browsers
```

Then enable live scraping:

```env
COMPETITOR_LIVE_SCRAPE_ENABLED=true
```

## Deployment Notes

Recommended production setup:

- Backend on Render.
- PostgreSQL on Neon.
- Frontend on a static host using `https://daraziq.store`.
- Daraz app callback set exactly to `https://your-backend-domain.com/api/daraz/callback`.
- Claude MCP connector URL set to `https://your-backend-domain.com/api/mcp`.

## Portfolio Highlights

This backend demonstrates:

- Marketplace OAuth integration with encrypted token storage.
- Full-stack SaaS authentication patterns.
- PostgreSQL schema design with Sequelize relationships.
- AI provider abstraction across OpenAI and OpenRouter.
- MCP server implementation with OAuth discovery and refresh-token support.
- Browser automation integrated into backend services.
- Cache-backed competitor intelligence workflows.
- Guardrail-driven pricing logic and audit-friendly reprice logging.
- Production deployment considerations for env, sessions, browser binaries, and external callbacks.
