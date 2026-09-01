# Interview Copilot

A real-time interview preparation desktop app. Listens to a mock or
permitted interview (your mic + system/loopback audio), detects when the
interviewer has asked a question, retrieves your strongest relevant
evidence from your own CV/GitHub projects, and generates a concise,
grounded answer — never fabricating experience you don't have.

Built with Tauri, React, TypeScript, and a local-first LLM/embedding stack
(Ollama by default, Groq as a free-tier fallback) so it runs at zero
ongoing cost.

## Status

Actively in development. Working end-to-end:

- Desktop shell (Tauri + React + Tailwind + shadcn/ui)
- Mic capture + native Windows (WASAPI) system-audio loopback capture, both transcribed via Groq Whisper
- Provider-agnostic LLM router with automatic failover (local Ollama pool → Groq → optional Anthropic)
- Knowledge base: CV/document upload, chunking, local embeddings, Postgres/pgvector retrieval
- GitHub repo ingestion (README + structured project-profile extraction)
- Job description parsing, requirement matching, likely questions, STAR story drafts
- Live session loop: question detection (debounced, noise-filtered) → grounded streaming answer
- Configurable response modes (direct / talking points / follow-up)

Not yet built: web research is wired but untested live (needs a Tavily
API key), and OAuth-based GitHub connect (a personal access token works
today; the Device Flow code path exists but isn't the primary UI yet).

## Project structure

```
apps/
  desktop/    Tauri + React frontend
  api/        Local Node/Express backend (all provider API keys live here — never in the frontend)
packages/
  shared/     Shared TypeScript types
  ai/         LLM provider abstraction + router (Ollama/Groq/Anthropic)
  knowledge/  Document parsing, chunking, embeddings, retrieval, job matching
  database/   Postgres/pgvector client
  github/     GitHub ingestion (PAT or OAuth Device Flow)
  search/     Web research provider abstraction
  interview/  Live session orchestrator (question detection + answer loop)
  transcription/  Speech-to-text client (Groq Whisper)
infra/
  docker-compose.yml   Local Postgres + pgvector
  schema.sql           Database schema
```

## Setup

Requirements: Node 22+, Rust (for the Tauri/WASAPI native module), Docker
Desktop, and [Ollama](https://ollama.com) running locally.

```bash
npm install
cp .env.example apps/api/.env   # fill in at least GROQ_API_KEY
docker compose -f infra/docker-compose.yml up -d
docker exec -i interview-copilot-postgres psql -U interview_copilot -d interview_copilot < infra/schema.sql
ollama pull all-minilm          # embeddings
```

Run the backend and frontend in separate terminals:

```bash
npm run dev --workspace=apps/api
npm run tauri dev --workspace=apps/desktop
```

## License

MIT — see [LICENSE](LICENSE).
