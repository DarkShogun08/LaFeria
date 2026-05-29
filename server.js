"use strict";

const http = require("http");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 3000);
const WS_PATH = "/ws";
const ROOM_TTL_MS = 30 * 60 * 1000;
const MAX_MESSAGE_BYTES = 256 * 1024;

const rooms = new Map();
const clients = new Map();

function hashPassword(password) {
  return crypto.createHash("sha256").update(String(password), "utf8").digest("hex");
}

function makeId(size = 8) {
  return crypto.randomBytes(size).toString("base64url").slice(0, size).toUpperCase();
}

function now() {
  return Date.now();
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("La Feria signaling server is running. WebSocket path: /ws\n");
});

server.on("upgrade", (req, socket) => {
  try {
    const { pathname } = new URL(req.url, "http://localhost");
    if (pathname !== WS_PATH) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    const key = req.headers["sec-websocket-key"];
    if (!key) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    const accept = crypto
      .createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");

    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "\r\n",
    ].join("\r\n"));

    registerClient(socket);
  } catch (err) {
    socket.destroy();
  }
});

function registerClient(socket) {
  const client = {
    id: makeId(10),
    socket,
    buffer: Buffer.alloc(0),
    roomId: "",
    displayName: "",
  };

  clients.set(client.id, client);
  send(client, "connected", { clientId: client.id });

  socket.on("data", chunk => receiveData(client, chunk));
  socket.on("close", () => removeClient(client));
  socket.on("error", () => removeClient(client));
}

function receiveData(client, chunk) {
  client.buffer = Buffer.concat([client.buffer, chunk]);

  if (client.buffer.length > MAX_MESSAGE_BYTES) {
    closeClient(client, 1009, "Mensaje demasiado grande.");
    return;
  }

  while (client.buffer.length >= 2) {
    let frame;
    try {
      frame = parseFrame(client.buffer);
    } catch (err) {
      closeClient(client, 1009, "Mensaje demasiado grande.");
      return;
    }
    if (!frame) return;
    client.buffer = client.buffer.subarray(frame.bytesRead);

    if (frame.opcode === 0x8) {
      removeClient(client);
      client.socket.end();
      return;
    }

    if (frame.opcode === 0x9) {
      sendFrame(client.socket, frame.payload, 0xA);
      continue;
    }

    if (frame.opcode !== 0x1) continue;

    if (frame.payload.length > MAX_MESSAGE_BYTES) {
      closeClient(client, 1009, "Mensaje demasiado grande.");
      return;
    }

    try {
      const message = JSON.parse(frame.payload.toString("utf8"));
      handleMessage(client, message);
    } catch (err) {
      sendError(client, "Mensaje invalido.");
    }
  }
}

function parseFrame(buffer) {
  if (buffer.length < 2) return null;

  const first = buffer[0];
  const second = buffer[1];
  const opcode = first & 0x0f;
  const masked = Boolean(second & 0x80);
  let length = second & 0x7f;
  let offset = 2;

  if (!masked) return null;

  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    const high = buffer.readUInt32BE(offset);
    const low = buffer.readUInt32BE(offset + 4);
    if (high !== 0 || low > MAX_MESSAGE_BYTES) throw new Error("Frame too large");
    length = low;
    offset += 8;
  }

  if (buffer.length < offset + 4 + length) return null;

  const mask = buffer.subarray(offset, offset + 4);
  offset += 4;
  const payload = Buffer.alloc(length);

  for (let i = 0; i < length; i += 1) {
    payload[i] = buffer[offset + i] ^ mask[i % 4];
  }

  return { opcode, payload, bytesRead: offset + length };
}

function sendFrame(socket, payload, opcode = 0x1) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  let header;

  if (body.length < 126) {
    header = Buffer.from([0x80 | opcode, body.length]);
  } else if (body.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(body.length, 6);
  }

  socket.write(Buffer.concat([header, body]));
}

function send(client, type, data = {}) {
  if (client.socket.destroyed) return;
  sendFrame(client.socket, JSON.stringify({ type, ...data }));
}

function sendError(client, message) {
  send(client, "error", { message });
}

function closeClient(client, code, reason) {
  const reasonBuffer = Buffer.from(reason || "");
  const payload = Buffer.alloc(2 + reasonBuffer.length);
  payload.writeUInt16BE(code, 0);
  reasonBuffer.copy(payload, 2);
  sendFrame(client.socket, payload, 0x8);
  client.socket.end();
  removeClient(client);
}

function handleMessage(client, message) {
  if (!message || typeof message.type !== "string") return sendError(client, "Mensaje invalido.");

  cleanupExpiredRooms();

  switch (message.type) {
    case "create-room":
      createRoom(client, message);
      break;

    case "list-rooms":
      send(client, "rooms-list", { rooms: listPublicRooms() });
      break;

    case "join-room":
      joinRoom(client, message);
      break;

    case "leave-room":
      leaveRoom(client);
      break;

    case "offer":
    case "answer":
    case "ice-candidate":
      relayToPeer(client, message);
      break;

    default:
      sendError(client, "Tipo de mensaje no soportado.");
  }
}

function createRoom(client, message) {
  const name = cleanText(message.name, 40);
  const password = String(message.password || "");

  if (!name) return sendError(client, "Escribe un nombre de sala.");
  if (password.length < 4) return sendError(client, "La contrasena debe tener al menos 4 caracteres.");

  leaveRoom(client);

  const room = {
    id: makeRoomId(),
    name,
    passwordHash: hashPassword(password),
    creatorId: client.id,
    clients: new Set([client.id]),
    createdAt: now(),
    lastActivity: now(),
  };

  client.roomId = room.id;
  client.displayName = cleanText(message.displayName, 24);
  rooms.set(room.id, room);
  send(client, "room-created", { room: publicRoom(room) });
  broadcastRoomListUpdated();
}

function makeRoomId() {
  let id = makeId(6);
  while (rooms.has(id)) id = makeId(6);
  return id;
}

function joinRoom(client, message) {
  const roomId = String(message.roomId || "").toUpperCase();
  const room = rooms.get(roomId);

  if (!room) return sendError(client, "La sala no existe o ha caducado.");
  if (room.clients.size >= 2 && !room.clients.has(client.id)) return sendError(client, "La sala ya esta llena.");
  if (room.passwordHash !== hashPassword(message.password || "")) return sendError(client, "Contrasena incorrecta.");

  leaveRoom(client);

  client.roomId = room.id;
  client.displayName = cleanText(message.displayName, 24);
  room.clients.add(client.id);
  room.lastActivity = now();

  send(client, "room-joined", { room: publicRoom(room) });

  if (room.clients.size === 2) {
    for (const id of room.clients) {
      const member = clients.get(id);
      if (member) send(member, "room-ready", { room: publicRoom(room), creatorId: room.creatorId });
    }
  }

  broadcastRoomListUpdated();
}

function leaveRoom(client) {
  if (!client.roomId) return;

  const room = rooms.get(client.roomId);
  client.roomId = "";

  if (!room) return;
  room.clients.delete(client.id);
  room.lastActivity = now();

  if (client.id === room.creatorId) {
    for (const id of room.clients) {
      const member = clients.get(id);
      if (member) {
        member.roomId = "";
        send(member, "room-closed", { message: "La sala no existe o ha caducado." });
      }
    }
    rooms.delete(room.id);
    broadcastRoomListUpdated();
    return;
  }

  for (const id of room.clients) {
    const member = clients.get(id);
    if (member) send(member, "peer-left");
  }

  if (room.clients.size === 0) {
    rooms.delete(room.id);
  }

  broadcastRoomListUpdated();
}

function relayToPeer(client, message) {
  const room = rooms.get(client.roomId);
  if (!room) return sendError(client, "La sala no existe o ha caducado.");

  room.lastActivity = now();

  for (const id of room.clients) {
    if (id === client.id) continue;
    const peer = clients.get(id);
    if (peer) {
      send(peer, message.type, {
        from: client.id,
        description: message.description,
        candidate: message.candidate,
      });
    }
  }
}

function removeClient(client) {
  if (!clients.has(client.id)) return;
  leaveRoom(client);
  clients.delete(client.id);
}

function publicRoom(room) {
  return {
    id: room.id,
    name: room.name,
    users: room.clients.size,
    available: room.clients.size < 2,
    createdAt: room.createdAt,
    lastActivity: room.lastActivity,
  };
}

function listPublicRooms() {
  cleanupExpiredRooms();
  return Array.from(rooms.values()).map(publicRoom);
}

function broadcastRoomListUpdated() {
  for (const client of clients.values()) {
    send(client, "room-list-updated");
  }
}

function cleanupExpiredRooms() {
  const limit = now() - ROOM_TTL_MS;
  for (const [id, room] of rooms) {
    if (room.lastActivity >= limit) continue;
    for (const clientId of room.clients) {
      const client = clients.get(clientId);
      if (client) {
        client.roomId = "";
        send(client, "room-closed", { message: "La sala no existe o ha caducado." });
      }
    }
    rooms.delete(id);
  }
}

function cleanText(value, maxLength) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, maxLength);
}

setInterval(cleanupExpiredRooms, 60 * 1000).unref();

server.listen(PORT, () => {
  console.log(`La Feria signaling server listening on http://localhost:${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}${WS_PATH}`);
});
