/**
 * Palm Climber v1 - Express + WebSocket Backend
 * Bridges the dashboard UI to the microcontroller via WebSocket
 */

const express = require("express");
const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");
const cors = require("cors");

const app = express();
const server = http.createServer(app);

// ─── WebSocket Servers ────────────────────────────────────────────────────────
// Two separate WS channels:
//   /dashboard  → browser dashboard connects here
//   /mcu        → microcontroller connects here

const wsDashboard = new WebSocketServer({ noServer: true });
const wsMCU = new WebSocketServer({ noServer: true });

// Track single MCU connection (one robot)
let mcuSocket = null;
// Track all dashboard connections
const dashboardClients = new Set();

// ─── Robot State ──────────────────────────────────────────────────────────────
let robotState = {
  height_m: 3.44,
  connected: true,
  topClamp: {
    position_mm: 80,
    speed_mms: 0,
    stroke_pct: 100,
  },
  bottomClamp: {
    position_mm: 75,
    speed_mms: 0,
    stroke_pct: 94,
  },
  mainActuator: {
    position_mm: 43,
    speed_mms: 0,
    stroke_pct: 29,
  },
  rollerSlider: {
    position_mm: -21,
    direction: "LEFT", // "LEFT" | "RIGHT" | "NONE"
    offset_pct: 8,
  },
  camera: {
    connected: false,
    resolution: null,
    fps: null,
    latency_ms: null,
  },
  lastUpdated: new Date().toISOString(),
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Broadcast a JSON message to all connected dashboard clients */
function broadcastToDashboards(payload) {
  const msg = JSON.stringify(payload);
  for (const client of dashboardClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

/** Send a command JSON message to the MCU */
function sendToMCU(payload) {
  if (mcuSocket && mcuSocket.readyState === WebSocket.OPEN) {
    mcuSocket.send(JSON.stringify(payload));
    return true;
  }
  return false; // MCU not connected
}

/** Validate & clamp a numeric value within [min, max] */
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// ─── Command Handlers ─────────────────────────────────────────────────────────
// Each command from the dashboard is validated here before forwarding to MCU.

const commandHandlers = {
  /**
   * SET_TOP_CLAMP
   * payload: { position_mm?: number, speed_mms?: number }
   */
  SET_TOP_CLAMP(data) {
    const cmd = { type: "SET_TOP_CLAMP" };
    if (data.position_mm !== undefined)
      cmd.position_mm = clamp(data.position_mm, 0, 80);
    if (data.speed_mms !== undefined)
      cmd.speed_mms = clamp(data.speed_mms, 0, 100);
    return cmd;
  },

  /**
   * SET_BOTTOM_CLAMP
   * payload: { position_mm?: number, speed_mms?: number }
   */
  SET_BOTTOM_CLAMP(data) {
    const cmd = { type: "SET_BOTTOM_CLAMP" };
    if (data.position_mm !== undefined)
      cmd.position_mm = clamp(data.position_mm, 0, 80);
    if (data.speed_mms !== undefined)
      cmd.speed_mms = clamp(data.speed_mms, 0, 100);
    return cmd;
  },

  /**
   * SET_MAIN_ACTUATOR
   * payload: { position_mm?: number, speed_mms?: number }
   */
  SET_MAIN_ACTUATOR(data) {
    const cmd = { type: "SET_MAIN_ACTUATOR" };
    if (data.position_mm !== undefined)
      cmd.position_mm = clamp(data.position_mm, 0, 150);
    if (data.speed_mms !== undefined)
      cmd.speed_mms = clamp(data.speed_mms, 0, 100);
    return cmd;
  },

  /**
   * SET_ROLLER_SLIDER
   * payload: { position_mm?: number, direction?: "LEFT"|"RIGHT"|"NONE" }
   */
  SET_ROLLER_SLIDER(data) {
    const cmd = { type: "SET_ROLLER_SLIDER" };
    if (data.position_mm !== undefined)
      cmd.position_mm = clamp(data.position_mm, -250, 250);
    if (data.direction !== undefined) {
      if (!["LEFT", "RIGHT", "NONE"].includes(data.direction))
        throw new Error("direction must be LEFT, RIGHT, or NONE");
      cmd.direction = data.direction;
    }
    return cmd;
  },

  /**
   * EXTEND / RETRACT helpers (hold-to-move style like the UI)
   * payload: { actuator: "top"|"bottom"|"main"|"roller", delta_mm: number }
   */
  MOVE_DELTA(data) {
    const allowed = ["top", "bottom", "main", "roller"];
    if (!allowed.includes(data.actuator))
      throw new Error(`actuator must be one of: ${allowed.join(", ")}`);
    return {
      type: "MOVE_DELTA",
      actuator: data.actuator,
      delta_mm: clamp(data.delta_mm ?? 1, -250, 250),
    };
  },

  /**
   * EMERGENCY_STOP – halts all motion immediately
   */
  EMERGENCY_STOP() {
    return { type: "EMERGENCY_STOP" };
  },

  /**
   * CLIMB – triggers an autonomous climb step
   * payload: { direction: "UP"|"DOWN" }
   */
  CLIMB(data) {
    if (!["UP", "DOWN"].includes(data.direction))
      throw new Error("direction must be UP or DOWN");
    return { type: "CLIMB", direction: data.direction };
  },
};

// ─── Dashboard WebSocket ──────────────────────────────────────────────────────

wsDashboard.on("connection", (ws) => {
  console.log("[Dashboard] Client connected");
  dashboardClients.add(ws);

  // Send current state immediately on connect
  ws.send(
    JSON.stringify({ type: "STATE_SNAPSHOT", data: robotState })
  );

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      ws.send(JSON.stringify({ type: "ERROR", message: "Invalid JSON" }));
      return;
    }

    const { type, ...data } = msg;

    // Handle command
    if (!commandHandlers[type]) {
      ws.send(
        JSON.stringify({ type: "ERROR", message: `Unknown command: ${type}` })
      );
      return;
    }

    let mcuCmd;
    try {
      mcuCmd = commandHandlers[type](data);
    } catch (err) {
      ws.send(JSON.stringify({ type: "ERROR", message: err.message }));
      return;
    }

    // Add request ID for tracing (optional, from dashboard)
    if (msg.requestId) mcuCmd.requestId = msg.requestId;

    const sent = sendToMCU(mcuCmd);
    ws.send(
      JSON.stringify({
        type: "ACK",
        command: type,
        forwarded: sent,
        mcuConnected: !!mcuSocket,
      })
    );

    if (!sent) {
      ws.send(
        JSON.stringify({
          type: "WARN",
          message: "MCU not connected — command not delivered",
        })
      );
    }
  });

  ws.on("close", () => {
    console.log("[Dashboard] Client disconnected");
    dashboardClients.delete(ws);
  });

  ws.on("error", (err) =>
    console.error("[Dashboard] WS error:", err.message)
  );
});

// ─── MCU WebSocket ────────────────────────────────────────────────────────────

wsMCU.on("connection", (ws) => {
  console.log("[MCU] Microcontroller connected");
  mcuSocket = ws;

  // Notify dashboards MCU is online
  broadcastToDashboards({ type: "MCU_STATUS", connected: true });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      console.error("[MCU] Received non-JSON message");
      return;
    }

    // MCU sends telemetry updates
    if (msg.type === "TELEMETRY") {
      // Merge partial updates into robotState
      const { type, ...updates } = msg;

      if (updates.height_m !== undefined)
        robotState.height_m = updates.height_m;
      if (updates.topClamp)
        Object.assign(robotState.topClamp, updates.topClamp);
      if (updates.bottomClamp)
        Object.assign(robotState.bottomClamp, updates.bottomClamp);
      if (updates.mainActuator)
        Object.assign(robotState.mainActuator, updates.mainActuator);
      if (updates.rollerSlider)
        Object.assign(robotState.rollerSlider, updates.rollerSlider);
      if (updates.camera)
        Object.assign(robotState.camera, updates.camera);

      robotState.lastUpdated = new Date().toISOString();

      // Forward live telemetry to all dashboard clients
      broadcastToDashboards({ type: "TELEMETRY", data: robotState });
    }

    // MCU acknowledges a command
    if (msg.type === "CMD_ACK") {
      broadcastToDashboards({ type: "CMD_ACK", ...msg });
    }

    // MCU reports an error
    if (msg.type === "MCU_ERROR") {
      broadcastToDashboards({ type: "MCU_ERROR", message: msg.message });
    }
  });

  ws.on("close", () => {
    console.log("[MCU] Microcontroller disconnected");
    mcuSocket = null;
    broadcastToDashboards({ type: "MCU_STATUS", connected: false });
  });

  ws.on("error", (err) => console.error("[MCU] WS error:", err.message));
});

// ─── HTTP Upgrade Routing ─────────────────────────────────────────────────────

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/dashboard") {
    wsDashboard.handleUpgrade(req, socket, head, (ws) =>
      wsDashboard.emit("connection", ws, req)
    );
  } else if (url.pathname === "/mcu") {
    wsMCU.handleUpgrade(req, socket, head, (ws) =>
      wsMCU.emit("connection", ws, req)
    );
  } else {
    socket.destroy();
  }
});

// ─── REST API ─────────────────────────────────────────────────────────────────

app.use(cors());
app.use(express.json());

/** GET /state – returns current robot state snapshot */
app.get("/state", (_req, res) => res.json(robotState));

/** GET /health */
app.get("/health", (_req, res) =>
  res.json({
    status: "ok",
    mcuConnected: !!mcuSocket,
    dashboardClients: dashboardClients.size,
    uptime: process.uptime(),
  })
);

/** POST /command – REST fallback (same validation as WS) */
// app.post("/command", (req, res) => {
//   const { type, ...data } = req.body ?? {};
//   if (!commandHandlers[type]) {
//     return res.status(400).json({ error: `Unknown command: ${type}` });
//   }
//   let mcuCmd;
//   try {
//     mcuCmd = commandHandlers[type](data);
//   } catch (err) {
//     return res.status(400).json({ error: err.message });
//   }
//   const sent = sendToMCU(mcuCmd);
//   res.json({ forwarded: sent, mcuConnected: !!mcuSocket, command: mcuCmd });
// });
server.on("upgrade", (request, socket, head) => {
  const { pathname } = new URL(request.url, `http://${request.headers.host}`);

  if (pathname === "/dashboard") {
    wsDashboard.handleUpgrade(request, socket, head, (ws) => {
      wsDashboard.emit("connection", ws, request);
    });
  } else if (pathname === "/mcu") {
    wsMCU.handleUpgrade(request, socket, head, (ws) => {
      wsMCU.emit("connection", ws, request);
    });
  } else {
    socket.destroy(); // Reject paths that don't match
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🌴 Palm Climber v1 Backend`);
  console.log(`   HTTP  → http://localhost:${PORT}`);
  console.log(`   WS Dashboard → ws://localhost:${PORT}/dashboard`);
  console.log(`   WS MCU       → ws://localhost:${PORT}/mcu\n`);
});