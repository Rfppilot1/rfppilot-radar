#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RadarClient } from "./client.js";
import { createRadarMcpServer } from "./tools.js";

const client = new RadarClient(
  process.env.RADAR_API_URL ?? "http://localhost:8080",
  process.env.RADAR_API_KEY ?? "",
);
const server = createRadarMcpServer(client, process.env.RADAR_PROFILE_ID);
await server.connect(new StdioServerTransport());
