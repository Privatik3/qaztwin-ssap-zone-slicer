"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const CONFIG = require("./config");

class LockManager {
  constructor(baseDir = CONFIG.baseDir, lockTimeoutMs = CONFIG.lockTimeoutMs) {
    this.BASE_DIR = baseDir;
    this.LOCK_TIMEOUT_MS = lockTimeoutMs;
    this.isProcessing = false;
  }

  ensureBaseDirExists() {
    try {
      if (!fs.existsSync(this.BASE_DIR)) {
        fs.mkdirSync(this.BASE_DIR, { recursive: true });
      }
    } catch (_e) {
      // noop
    }
  }

  getLockFilePath() {
    return path.join(this.BASE_DIR, ".processing.lock");
  }

  isPidAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return false;
    }
  }

  getLockStatus() {
    this.ensureBaseDirExists();
    const lockPath = this.getLockFilePath();
    try {
      if (!fs.existsSync(lockPath)) {
        return { exists: false };
      }

      const stats = fs.statSync(lockPath);
      const text = fs.readFileSync(lockPath, "utf8");
      const info = JSON.parse(text);
      const lockAge = Date.now() - stats.mtime.getTime();
      const isStale = lockAge > this.LOCK_TIMEOUT_MS;
      const sameHost = info?.host ? info.host === os.hostname() : true;
      const pidAlive =
        sameHost && info && typeof info.pid === "number"
          ? this.isPidAlive(info.pid)
          : null;

      return {
        exists: true,
        path: lockPath,
        age: lockAge,
        ageFormatted: `${(lockAge / 1000).toFixed(1)}s`,
        isStale,
        timeout: this.LOCK_TIMEOUT_MS,
        timeoutFormatted: `${(this.LOCK_TIMEOUT_MS / 1000).toFixed(1)}s`,
        pid: info?.pid,
        pidAlive,
        sameHost,
        startedAt: info?.startedAt,
        host: info?.host,
        currentHost: os.hostname(),
      };
    } catch (error) {
      return {
        exists: true,
        path: lockPath,
        error: error.message,
        corrupted: true,
      };
    }
  }

  acquireLock() {
    this.ensureBaseDirExists();
    const lockPath = this.getLockFilePath();
    const payload = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      host: os.hostname(),
    };

    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeFileSync(fd, JSON.stringify(payload, null, 2));
      fs.closeSync(fd);
      console.log(`🔒 Lock acquired successfully`);
      return true;
    } catch (err) {
      if (err && err.code === "EEXIST") {
        try {
          // Check if lock file exists and get its stats
          const stats = fs.statSync(lockPath);
          const lockAge = Date.now() - stats.mtime.getTime();

          console.log(
            `🔍 Lock file exists (age: ${(lockAge / 1000).toFixed(1)}s)`
          );

          // If lock is older than timeout, consider it stale
          if (lockAge > this.LOCK_TIMEOUT_MS) {
            console.log(
              `⏰ Lock file is stale (older than ${
                this.LOCK_TIMEOUT_MS / 1000
              }s), removing...`
            );
            fs.rmSync(lockPath, { force: true });

            // Try to acquire lock again
            const fd = fs.openSync(lockPath, "wx");
            fs.writeFileSync(fd, JSON.stringify(payload, null, 2));
            fs.closeSync(fd);
            console.log(`🔒 Lock acquired after removing stale lock`);
            return true;
          }

          // Lock is not stale, check if the process is still alive
          const text = fs.readFileSync(lockPath, "utf8");
          const info = JSON.parse(text);

          if (info && typeof info.pid === "number") {
            if (info.host && info.host !== os.hostname()) {
              console.log(
                `🖥️  Lock belongs to a different host (${info.host}). Will not remove unless stale.`
              );
              return false;
            }
            const pidAlive = this.isPidAlive(info.pid);
            console.log(
              `🔍 Lock PID ${info.pid} is ${pidAlive ? "alive" : "dead"}`
            );

            if (!pidAlive) {
              console.log(`💀 Lock process is dead, removing stale lock...`);
              fs.rmSync(lockPath, { force: true });

              // Try to acquire lock again
              const fd = fs.openSync(lockPath, "wx");
              fs.writeFileSync(fd, JSON.stringify(payload, null, 2));
              fs.closeSync(fd);
              console.log(`🔒 Lock acquired after removing dead process lock`);
              return true;
            }

            // Process is still alive and lock is not stale
            console.log(`🚫 Lock is held by active process (PID: ${info.pid})`);
            return false;
          } else {
            // Invalid lock file format, remove it
            console.log(`⚠️ Invalid lock file format, removing...`);
            fs.rmSync(lockPath, { force: true });

            const fd = fs.openSync(lockPath, "wx");
            fs.writeFileSync(fd, JSON.stringify(payload, null, 2));
            fs.closeSync(fd);
            console.log(`🔒 Lock acquired after removing invalid lock`);
            return true;
          }
        } catch (parseErr) {
          console.log(
            `❌ Error reading/parsing lock file: ${parseErr.message}`
          );
          // Try to remove corrupted lock file
          try {
            fs.rmSync(lockPath, { force: true });
            const fd = fs.openSync(lockPath, "wx");
            fs.writeFileSync(fd, JSON.stringify(payload, null, 2));
            fs.closeSync(fd);
            console.log(`🔒 Lock acquired after removing corrupted lock`);
            return true;
          } catch (removeErr) {
            console.log(
              `❌ Failed to remove corrupted lock file: ${removeErr.message}`
            );
            return false;
          }
        }
      }
      console.log(`❌ Failed to acquire lock: ${err.message}`);
      return false;
    }
  }

  releaseLock() {
    this.ensureBaseDirExists();
    const lockPath = this.getLockFilePath();
    try {
      if (fs.existsSync(lockPath)) {
        fs.rmSync(lockPath, { force: true });
        console.log(`🔓 Lock released successfully`);
      } else {
        console.log(`⚠️ Lock file not found when trying to release`);
      }
    } catch (error) {
      console.log(`❌ Error releasing lock: ${error.message}`);
      // Don't throw here as this might be called in cleanup
    }
  }

  cleanupOrphanedLocks() {
    const lockStatus = this.getLockStatus();

    if (!lockStatus.exists) {
      console.log(`🔍 No existing lock file found on startup`);
      return;
    }

    console.log(
      `🔍 Found existing lock file on startup:`,
      JSON.stringify(lockStatus, null, 2)
    );

    // If lock is stale or local process is dead, clean it up
    if (
      lockStatus.isStale ||
      (lockStatus.sameHost && lockStatus.pid && lockStatus.pidAlive === false)
    ) {
      console.log(`🧹 Cleaning up orphaned/stale lock on startup`);
      try {
        this.releaseLock();
        console.log(`✅ Orphaned lock cleaned up successfully`);
      } catch (error) {
        console.log(`❌ Failed to cleanup orphaned lock: ${error.message}`);
      }
    } else {
      if (!lockStatus.sameHost) {
        console.log(
          `⚠️ Active lock found on different host (${lockStatus.host}); leaving it alone`
        );
      } else {
        console.log(
          `⚠️ Active lock found (${lockStatus.ageFormatted} old), leaving it alone`
        );
      }
    }
  }

  // Public method to check if processing is allowed
  canProcess() {
    return !this.isProcessing;
  }

  // Public method to set processing state
  setProcessing(state) {
    this.isProcessing = state;
  }

  // Public method to get processing state
  isCurrentlyProcessing() {
    return this.isProcessing;
  }

  // Periodic cleanup of stale locks (call this every few minutes)
  periodicCleanup() {
    const lockStatus = this.getLockStatus();

    if (!lockStatus.exists) {
      return false; // No cleanup needed
    }

    // Only cleanup if lock is stale or local process is dead
    if (
      lockStatus.isStale ||
      (lockStatus.sameHost && lockStatus.pid && lockStatus.pidAlive === false)
    ) {
      console.log(`🧹 Periodic cleanup: removing stale lock`);
      try {
        this.releaseLock();
        console.log(`✅ Stale lock cleaned up during periodic check`);
        return true; // Cleanup performed
      } catch (error) {
        console.log(
          `❌ Failed to cleanup stale lock during periodic check: ${error.message}`
        );
        return false;
      }
    }

    return false; // No cleanup needed
  }

  // Force cleanup (ignores active processes, use with caution)
  forceCleanup() {
    const lockStatus = this.getLockStatus();

    if (!lockStatus.exists) {
      return false;
    }

    console.log(`🔧 Force cleanup: removing lock file regardless of state`);
    try {
      this.releaseLock();
      console.log(`✅ Lock file forcibly removed`);
      return true;
    } catch (error) {
      console.log(`❌ Failed to forcibly remove lock file: ${error.message}`);
      return false;
    }
  }
}

module.exports = LockManager;
