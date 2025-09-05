#!/usr/bin/env node

const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const CONFIG = require("./config");

const app = express();
const PORT = CONFIG.port;

// Global flag to prevent multiple processes from running simultaneously
let isProcessing = false;

// Middleware
app.use(cors());
app.use(express.json({ limit: "50mb" }));

// Configuration
const BLENDER_PATH = CONFIG.blenderPath;
const PYTHON_SCRIPT = CONFIG.pythonScript;
const BASE_DIR = CONFIG.baseDir;
const WORKSPACE_DIR = "/workspace";

// Validation function
function validateParams(params) {
  const errors = [];

  const requiredParams = [
    "blockPositionX",
    "blockPositionY",
    "blockSizeX",
    "blockSizeY",
    "blockRotationZ",
    "textureTargetResolution",
    "inputFileName",
    "outputFilePath",
  ];

  // Validate output file path
  if (typeof params.outputFilePath !== "string") {
    errors.push("outputFilePath must be a string");
  } else if (!params.outputFilePath.endsWith(".glb")) {
    errors.push("outputFilePath must end with .glb");
  } else if (params.outputFilePath.includes("..")) {
    errors.push("outputFilePath cannot contain '..' for security");
  }

  requiredParams.forEach((param) => {
    if (params[param] === undefined || params[param] === null) {
      errors.push(`${param} is required`);
    }
  });

  // Type validation
  if (typeof params.blockPositionX !== "number") {
    errors.push("blockPositionX must be a number");
  }
  if (typeof params.blockPositionY !== "number") {
    errors.push("blockPositionY must be a number");
  }
  if (typeof params.blockSizeX !== "number" || params.blockSizeX <= 0) {
    errors.push("blockSizeX must be a positive number");
  }
  if (typeof params.blockSizeY !== "number" || params.blockSizeY <= 0) {
    errors.push("blockSizeY must be a positive number");
  }
  if (typeof params.blockRotationZ !== "number") {
    errors.push("blockRotationZ must be a number");
  }
  if (
    typeof params.textureTargetResolution !== "number" ||
    params.textureTargetResolution <= 0
  ) {
    errors.push("textureTargetResolution must be a positive number");
  }
  if (typeof params.enableDracoCompression !== "boolean") {
    params.enableDracoCompression = false; // default to false
  }

  return errors;
}

// Prepare environment variables for Python script
function prepareEnvironment(params, outputPath) {
  return {
    ...process.env,
    BLOCK_POSITION_X: params.blockPositionX.toString(),
    BLOCK_POSITION_Y: params.blockPositionY.toString(),
    BLOCK_SIZE_X: params.blockSizeX.toString(),
    BLOCK_SIZE_Y: params.blockSizeY.toString(),
    BLOCK_ROTATION_Z: params.blockRotationZ.toString(),
    TEXTURE_TARGET_RESOLUTION: params.textureTargetResolution.toString(),
    ENABLE_DRACO_COMPRESSION: params.enableDracoCompression.toString(),
    INPUT_FILE_PATH: path.join(BASE_DIR, params.inputFileName),
    OUTPUT_FILE_PATH: outputPath,
  };
}

// Helper function to ensure directory exists (delete and recreate if exists)
function ensureDirectoryExists(filePath) {
  const dir = path.dirname(filePath);

  // If the directory is the same as BASE_DIR, don't delete it
  if (dir === BASE_DIR) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return;
  }

  // For subdirectories, delete and recreate if they exist
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(dir, { recursive: true });
}

// Concurrency control via lock file in BASE_DIR
function getLockFilePath() {
  return path.join(BASE_DIR, ".processing.lock");
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

function acquireLock() {
  const lockPath = getLockFilePath();
  const payload = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    host: os.hostname(),
  };
  try {
    const fd = fs.openSync(lockPath, "wx");
    fs.writeFileSync(fd, JSON.stringify(payload, null, 2));
    fs.closeSync(fd);
    return true;
  } catch (err) {
    if (err && err.code === "EEXIST") {
      try {
        const text = fs.readFileSync(lockPath, "utf8");
        const info = JSON.parse(text);
        if (info && typeof info.pid === "number" && isPidAlive(info.pid)) {
          return false;
        }
        // Stale lock, remove and retry once
        fs.rmSync(lockPath, { force: true });
        const fd = fs.openSync(lockPath, "wx");
        fs.writeFileSync(fd, JSON.stringify(payload, null, 2));
        fs.closeSync(fd);
        return true;
      } catch (_e) {
        return false;
      }
    }
    return false;
  }
}

function releaseLock() {
  const lockPath = getLockFilePath();
  try {
    if (fs.existsSync(lockPath)) {
      fs.rmSync(lockPath, { force: true });
    }
  } catch (_e) {
    // noop
  }
}

// Main processing function
async function process3DModel(params) {
  return new Promise((resolve, reject) => {
    // Determine output file path
    const outputPath = path.join(BASE_DIR, params.outputFilePath);
    const outputFileName = path.basename(outputPath);

    console.log(`▶️  START: Processing ${params.inputFileName}`);

    // Ensure output directory exists
    ensureDirectoryExists(outputPath);

    // Check if input file exists
    const inputFilePath = path.join(BASE_DIR, params.inputFileName);
    if (!fs.existsSync(inputFilePath)) {
      reject(new Error(`Input file not found: ${params.inputFileName}`));
      return;
    }

    // Change to workspace directory
    process.chdir(WORKSPACE_DIR);

    const env = prepareEnvironment(params, outputPath);

    console.log(`🔧 BLENDER: Starting process for ${params.inputFileName}`);

    // Spawn Blender process
    const blenderProcess = spawn(
      BLENDER_PATH,
      ["--background", "--python", PYTHON_SCRIPT],
      {
        env,
        stdio: ["pipe", "ignore", "pipe"], // Suppress stdout, capture stderr
      }
    );

    let stderr = "";
    let timedOut = false;

    // Enforce configurable timeout
    const timeoutMs = Number(CONFIG.processTimeoutMs) || 0;
    let timeoutHandle = null;
    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        try {
          blenderProcess.kill("SIGKILL");
        } catch (e) {
          // Ignore kill errors
        }
      }, timeoutMs);
    }

    // Capture stderr only
    blenderProcess.stderr.on("data", (data) => {
      const error = data.toString();
      stderr += error;
    });

    // Handle process completion
    blenderProcess.on("close", (code) => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }

      if (timedOut) {
        return reject(new Error(`Processing timed out after ${timeoutMs} ms`));
      }

      if (code === 0) {
        // Check if output file was created
        try {
          if (fs.existsSync(outputPath)) {
            const stats = fs.statSync(outputPath);
            const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
            console.log(
              `✅ SUCCESS: Generated ${outputFileName} (${sizeMB}MB)`
            );
            console.log(`${"=".repeat(60)}`);
            resolve({
              success: true,
              outputFiles: [
                {
                  filename: outputFileName,
                  size: stats.size,
                  path: outputPath,
                },
              ],
              code: code,
              message: `Successfully processed ${params.inputFileName}`,
            });
          } else {
            console.log(
              `⚠️  WARNING: Processing completed but ${outputFileName} not found`
            );
            console.log(`${"=".repeat(60)}`);
            resolve({
              success: true,
              outputFiles: [],
              code: code,
              message: "Processing completed but output file was not found",
            });
          }
        } catch (error) {
          console.log(
            `❌ ERROR: Failed to verify output file: ${error.message}`
          );
          console.log(`${"=".repeat(60)}`);
          reject(error);
        }
      } else {
        console.log(`❌ BLENDER ERROR: Process failed with code ${code}`);
        if (stderr) {
          console.log(`   Details: ${stderr.trim()}`);
        }
        console.log(`${"=".repeat(60)}`);
        reject(
          new Error(`Blender process failed with code ${code}: ${stderr}`)
        );
      }
    });

    // Handle process errors
    blenderProcess.on("error", (error) => {
      reject(error);
    });
  });
}

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    service: "3D Zone Slicer API",
  });
});

// Main processing endpoint
app.post("/zone-preview", async (req, res) => {
  try {
    // Check if another process is already running
    if (isProcessing) {
      return res.status(409).json({
        success: false,
        error:
          "Another processing job is already running. Please wait for it to complete.",
        timestamp: new Date().toISOString(),
      });
    }

    const params = req.body;

    // Validate request parameters
    const validationErrors = validateParams(params);
    if (validationErrors.length > 0) {
      return res.status(400).json({
        success: false,
        error: "Validation failed",
        details: validationErrors,
      });
    }

    console.log(`\n${"=".repeat(60)}`);
    console.log(
      `📦 NEW REQUEST: ${params.inputFileName} → ${params.outputFilePath}`
    );
    console.log(`${"-".repeat(60)}`);
    console.log(
      `   📐 Block: (${params.blockPositionX}, ${params.blockPositionY}) | Size: ${params.blockSizeX}x${params.blockSizeY}`
    );
    console.log(
      `   🔄 Rotation: ${params.blockRotationZ}° | 🎨 Texture: ${
        params.textureTargetResolution
      }px | 🗜️ Draco: ${params.enableDracoCompression ? "ON" : "OFF"}`
    );
    console.log(`${"-".repeat(60)}`);

    // Attempt to acquire lock (filesystem + in-memory)
    const lockAcquired = acquireLock();
    if (!lockAcquired) {
      console.log(`🚫 BUSY: Service busy, rejecting ${params.inputFileName}`);
      console.log(`${"=".repeat(60)}`);
      return res.status(409).json({
        success: false,
        error: "Service is busy with another processing job.",
        timestamp: new Date().toISOString(),
      });
    }

    // Set processing flag after acquiring lock
    isProcessing = true;

    try {
      // Process the 3D model
      const result = await process3DModel(params);

      res.json({
        success: true,
        data: result,
        timestamp: new Date().toISOString(),
      });
    } finally {
      // Always clear flags/locks
      isProcessing = false;
      releaseLock();
    }
  } catch (error) {
    console.log(`💥 PROCESSING ERROR: ${error.message}`);
    console.log(`${"=".repeat(60)}`);
    // Reset the processing flag on error
    isProcessing = false;
    releaseLock();
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error("Unhandled error:", error);
  res.status(500).json({
    success: false,
    error: "Internal server error",
    timestamp: new Date().toISOString(),
  });
});

// 404 handler
app.use("*", (req, res) => {
  res.status(404).json({
    success: false,
    error: "Endpoint not found",
    timestamp: new Date().toISOString(),
  });
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n⚠️ Received SIGINT, shutting down gracefully...");
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("\n⚠️ Received SIGTERM, shutting down gracefully...");
  process.exit(0);
});

// Start server
app.listen(PORT, "0.0.0.0", () => {
  console.log("🚀 3D Zone Slicer API Server Started");
  console.log("=".repeat(50));
  console.log(`📡 Server listening on port ${PORT}`);
  console.log(`🌐 Available at: http://0.0.0.0:${PORT}`);
  console.log(`🏥 Health check: http://0.0.0.0:${PORT}/health`);
  console.log(
    `🎯 Processing endpoint: POST http://0.0.0.0:${PORT}/zone-preview`
  );
  console.log("=".repeat(50));
});

module.exports = app;
