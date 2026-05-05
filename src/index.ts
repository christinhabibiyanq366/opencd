#!/usr/bin/env node
import "dotenv/config";

import { DiscordBridge } from "./discord-bridge.js";

const app = new DiscordBridge();
await app.start();

