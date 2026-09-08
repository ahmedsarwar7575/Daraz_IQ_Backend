# daraziq.store Intelligence Platform

daraziq.store is a SaaS intelligence platform for Daraz sellers. It connects seller account data, product snapshots, competitor signals, AI briefs, pricing guardrails, and MCP access into one protected operating layer.

This backend powers the product experience behind the website and external AI clients. It is responsible for account security, marketplace connection, seller-scoped analytics, product intelligence, pricing decisions, and MCP authorization.

## Product Mission

Daraz sellers need faster answers before they change inventory, pricing, ads, or catalog strategy. daraziq.store gives sellers a single workspace to understand what changed, why it matters, and which action is safest under their own business rules.

## Core Capabilities

- Seller authentication and account sessions.
- Daraz seller connection and disconnect flow.
- Encrypted storage for sensitive access credentials.
- Store performance snapshots and historical trend context.
- Product catalog snapshots for seller-owned listings.
- Competitor market search and price-band analysis.
- AI-supported business briefs for store, product, and pricing workflows.
- Pricing guardrails for margin, movement limits, and auditability.
- Reprice history so every recommendation or attempted price move is traceable.
- OAuth-protected MCP tools for connected AI clients.

## SaaS Workflows

| Workflow | Outcome |
| --- | --- |
| Connect Store | Sellers authorize a Daraz account and bring seller context into the workspace. |
| Review Performance | Sellers see orders, revenue, fulfillment signals, source sync, and trend context. |
| Benchmark Products | Sellers compare their own listings against market price, reviews, sales, and listing signals. |
| Control Pricing | Sellers receive recommendations bounded by cost, floor, ceiling, and movement rules. |
| Use AI Briefs | Sellers get concise summaries grounded in the current workspace data. |
| Connect MCP Clients | Authorized clients can call account-scoped seller tools through a protected MCP endpoint. |

## Security And Privacy Principles

- Sensitive credentials are encrypted before storage.
- MCP access is tied to authorized seller identity and scoped tokens.
- Pricing workflows keep audit records for review.
- Live marketplace writes stay guarded by product controls.
- Public documentation, product copy, screenshots, and demo content must not include personal information.

Do not publish real emails, customer names, access tokens, API keys, seller secrets, order records, private revenue data, or marketplace credentials in this README or any public-facing product material.

## Demo Data Standard

Showcase workspaces may use synthetic seller data to demonstrate product value. Synthetic records can include realistic products, prices, reviews, stock, orders, and competitor bands, but they must not expose or impersonate a real customer, real seller account, or real private transaction history.

Demo data should remain scoped to the intended showcase account and must not change other users.

## MCP Product Surface

daraziq.store exposes an MCP interface so compatible AI clients can work with the same seller intelligence layer as the web app.

Available product areas include:

- Store metrics
- Metrics history
- Store performance analysis
- Own product lookup
- Competitor search
- Product analysis
- Anomaly checks
- Pricing analysis
- Guarded reprice logging
- Reprice history

MCP clients must authorize before accessing seller tools, and every tool runs in the context of the authenticated seller workspace.

## AI Product Surface

AI briefs use structured seller data from daraziq.store. The platform should not invent orders, revenue, pricing, stock, reviews, ratings, or competitor metrics. Recommendations should stay practical, concise, and grounded in the displayed data.

## Product Voice

daraziq.store should sound like a serious SaaS product for marketplace sellers:

- Clear and useful.
- Security-aware without fear-based language.
- Business-focused instead of developer-focused.
- Honest about AI as decision support.
- Specific about seller outcomes.
