"use strict";

const path = require("path");

// Load env once here so all consumers share the same config
require("dotenv").config();

const DEFAULT_BASE_DIR = "/workspace/data";

/**
 * Normalizes BASE_DIR to be an absolute path inside the container under /workspace
 * Accepts values like "./data" or "/workspace/data".
 */
function resolveBaseDir(envBaseDir) {
  if (!envBaseDir || envBaseDir.trim() === "") return DEFAULT_BASE_DIR;
  // If starts with '.', treat as relative to /workspace
  if (envBaseDir.startsWith(".")) {
    return path.posix.join("/workspace", envBaseDir.replace(/^\./, ""));
  }
  // If already absolute, keep it
  if (envBaseDir.startsWith("/")) return envBaseDir;
  // Otherwise, join under /workspace
  return path.posix.join("/workspace", envBaseDir);
}

const BASE_DIR = resolveBaseDir(process.env.BASE_DIR);

const CONFIG = {
  port: Number(process.env.PORT || 5000),
  nodeEnv: process.env.NODE_ENV || "production",
  baseDir: BASE_DIR,
  blenderPath: "/opt/blender/blender",
  pythonScript: "/workspace/scripts/box_cut.py",
  processTimeoutMs: Number(process.env.PROCESS_TIMEOUT_MS || 5 * 60 * 1000),
};

module.exports = CONFIG;
