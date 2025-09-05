"use strict";

// Load env once here so all consumers share the same config
require("dotenv").config();

const CONFIG = {
  port: Number(process.env.PORT || 4103),
  nodeEnv: process.env.NODE_ENV || "production",
  baseDir: "/workspace/data",
  blenderPath: "/opt/blender/blender",
  pythonScript: "/workspace/scripts/box_cut.py",
  processTimeoutMs: Number(process.env.PROCESS_TIMEOUT_MS || 5 * 60 * 1000),
};

module.exports = CONFIG;
