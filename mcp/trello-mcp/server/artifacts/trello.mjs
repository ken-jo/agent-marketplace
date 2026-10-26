#!/usr/bin/env node

// src/index.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpError as McpError4, ErrorCode as ErrorCode4 } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod/v4";

// src/trello-client.ts
import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";

// src/rate-limiter.ts
class TokenBucketRateLimiter {
  tokens;
  lastRefill;
  maxTokens;
  refillRate;
  refillInterval;
  constructor(maxRequests, windowMs) {
    this.maxTokens = maxRequests;
    this.tokens = maxRequests;
    this.lastRefill = Date.now();
    this.refillInterval = windowMs;
    this.refillRate = maxRequests / windowMs;
  }
  refillTokens() {
    const now = Date.now();
    const timePassed = now - this.lastRefill;
    const newTokens = timePassed * this.refillRate;
    this.tokens = Math.min(this.maxTokens, this.tokens + newTokens);
    this.lastRefill = now;
  }
  canMakeRequest() {
    this.refillTokens();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
  async waitForAvailableToken() {
    return new Promise((resolve) => {
      const check = () => {
        if (this.canMakeRequest()) {
          resolve();
        } else {
          const tokensNeeded = 1 - this.tokens;
          const msToWait = tokensNeeded / this.refillRate;
          setTimeout(check, Math.min(msToWait, 100));
        }
      };
      check();
    });
  }
}
var createTrelloRateLimiters = () => {
  const apiKeyLimiter = new TokenBucketRateLimiter(300, 1e4);
  const tokenLimiter = new TokenBucketRateLimiter(100, 1e4);
  return {
    apiKeyLimiter,
    tokenLimiter,
    canMakeRequest() {
      return apiKeyLimiter.canMakeRequest() && tokenLimiter.canMakeRequest();
    },
    async waitForAvailableToken() {
      await Promise.all([
        apiKeyLimiter.waitForAvailableToken(),
        tokenLimiter.waitForAvailableToken()
      ]);
    }
  };
};

// src/trello-client.ts
import { McpError as McpError3, ErrorCode as ErrorCode3 } from "@modelcontextprotocol/sdk/types.js";
import * as fs2 from "fs/promises";
import * as path2 from "path";

// src/trello/attachments.ts
import FormData from "form-data";
import * as fs from "fs/promises";
import * as path from "path";
import { createReadStream } from "fs";
import { fileURLToPath } from "url";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
var MIME_TYPES = Object.freeze({
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".log": "text/plain",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".ts": "application/typescript",
  ".tsx": "application/typescript",
  ".jsx": "application/javascript",
  ".json": "application/json",
  ".xml": "application/xml",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".rar": "application/vnd.rar",
  ".7z": "application/x-7z-compressed",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".avi": "video/x-msvideo",
  ".mov": "video/quicktime",
  ".wmv": "video/x-ms-wmv",
  ".flv": "video/x-flv",
  ".webm": "video/webm"
});
var DEFAULT_MIME_TYPE = "application/octet-stream";
function mimeFromFilename(filename) {
  if (!filename)
    return;
  const ext = path.extname(filename).toLowerCase();
  return MIME_TYPES[ext];
}
function extensionFromMime(mimeType) {
  const match = Object.entries(MIME_TYPES).find(([, mime]) => mime === mimeType);
  return match?.[0] ?? "";
}
async function attachData(axiosInstance, { cardId, data, name, mimeType }) {
  let buffer;
  let effectiveMimeType = mimeType;
  if (data.startsWith("data:")) {
    const matches = data.match(/^data:([^;]+);base64,(.+)$/);
    if (!matches) {
      throw new McpError(ErrorCode.InvalidRequest, "Invalid data URL format");
    }
    effectiveMimeType = effectiveMimeType || matches[1];
    buffer = Buffer.from(matches[2], "base64");
  } else {
    buffer = Buffer.from(data, "base64");
  }
  effectiveMimeType = effectiveMimeType || mimeFromFilename(name) || DEFAULT_MIME_TYPE;
  const extension = extensionFromMime(effectiveMimeType);
  const fileName = name || `attachment-${Date.now()}${extension}`;
  const form = new FormData;
  form.append("file", buffer, { filename: fileName, contentType: effectiveMimeType });
  form.append("name", fileName);
  form.append("mimeType", effectiveMimeType);
  const response = await axiosInstance.post(`/cards/${cardId}/attachments`, form, {
    headers: { ...form.getHeaders() }
  });
  return response.data;
}
async function attachImageData(axiosInstance, { cardId, imageData, name, mimeType }) {
  return attachData(axiosInstance, {
    cardId,
    data: imageData,
    name: name || `screenshot-${Date.now()}.png`,
    mimeType: mimeType || "image/png"
  });
}
async function attachFile(axiosInstance, { cardId, fileUrl, name, mimeType }) {
  if (fileUrl.startsWith("file://")) {
    return uploadLocalFile(axiosInstance, { cardId, fileUrl, name, mimeType });
  }
  return attachRemoteUrl(axiosInstance, { cardId, fileUrl, name, mimeType });
}
async function uploadLocalFile(axiosInstance, { cardId, fileUrl, name, mimeType }) {
  let localPath;
  try {
    localPath = fileURLToPath(fileUrl);
  } catch {
    throw new McpError(ErrorCode.InvalidRequest, `Invalid file URL: ${fileUrl}`);
  }
  const effectiveMimeType = mimeType || mimeFromFilename(localPath) || DEFAULT_MIME_TYPE;
  try {
    await fs.access(localPath);
  } catch {
    throw new McpError(ErrorCode.InvalidRequest, `File not found: ${localPath}`);
  }
  const fileName = name || path.basename(localPath);
  const form = new FormData;
  form.append("file", createReadStream(localPath), {
    filename: fileName,
    contentType: effectiveMimeType
  });
  form.append("name", fileName);
  form.append("mimeType", effectiveMimeType);
  const response = await axiosInstance.post(`/cards/${cardId}/attachments`, form, {
    headers: { ...form.getHeaders() }
  });
  return response.data;
}
async function attachRemoteUrl(axiosInstance, { cardId, fileUrl, name, mimeType }) {
  let remoteUrlPath;
  try {
    remoteUrlPath = new URL(fileUrl).pathname;
  } catch {
    throw new McpError(ErrorCode.InvalidRequest, `Invalid URL: ${fileUrl}`);
  }
  const effectiveMimeType = mimeType || mimeFromFilename(remoteUrlPath) || DEFAULT_MIME_TYPE;
  const response = await axiosInstance.post(`/cards/${cardId}/attachments`, {
    url: fileUrl,
    name: name || "File Attachment",
    mimeType: effectiveMimeType
  });
  return response.data;
}
async function attachImage(axiosInstance, { cardId, imageUrl, name }) {
  return attachFile(axiosInstance, {
    cardId,
    fileUrl: imageUrl,
    name: name || "Image Attachment"
  });
}

// src/url-validator.ts
import { McpError as McpError2, ErrorCode as ErrorCode2 } from "@modelcontextprotocol/sdk/types.js";
import * as net from "net";
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const parts = ip.split(".").map(Number);
    const first = parts[0];
    const second = parts[1];
    if (first === 127)
      return true;
    if (first === 10)
      return true;
    if (first === 172 && second >= 16 && second <= 31)
      return true;
    if (first === 192 && second === 168)
      return true;
    if (first === 169 && second === 254)
      return true;
    if (first === 0)
      return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const normalized = ip.toLowerCase();
    if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1")
      return true;
    if (normalized === "::" || normalized === "0:0:0:0:0:0:0:0")
      return true;
    if (normalized.startsWith("fc") || normalized.startsWith("fd"))
      return true;
    if (normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) {
      return true;
    }
    if (normalized.startsWith("::ffff:")) {
      const ipv4Part = normalized.substring(7);
      if (net.isIPv4(ipv4Part)) {
        return isPrivateIp(ipv4Part);
      }
    }
    return false;
  }
  return false;
}
function validateExternalUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new McpError2(ErrorCode2.InvalidRequest, `Invalid URL: ${url}`);
  }
  if (parsed.protocol !== "https:") {
    throw new McpError2(ErrorCode2.InvalidRequest, `Only HTTPS URLs are allowed, got: ${parsed.protocol}`);
  }
  const hostname = parsed.hostname;
  if (hostname.toLowerCase() === "localhost") {
    throw new McpError2(ErrorCode2.InvalidRequest, `URLs pointing to private or local addresses are not allowed: ${hostname}`);
  }
  let ipToCheck = hostname;
  if (ipToCheck.startsWith("[") && ipToCheck.endsWith("]")) {
    ipToCheck = ipToCheck.slice(1, -1);
  }
  if (isPrivateIp(ipToCheck)) {
    throw new McpError2(ErrorCode2.InvalidRequest, `URLs pointing to private or local addresses are not allowed: ${hostname}`);
  }
}

// src/trello-client.ts
var CONFIG_DIR = path2.join(process.env.HOME || process.env.USERPROFILE || ".", ".trello-mcp");
var CONFIG_FILE = path2.join(CONFIG_DIR, "config.json");

class TrelloClient {
  config;
  axiosInstance;
  rateLimiter;
  defaultBoardId;
  activeConfig;
  constructor(config) {
    this.config = config;
    this.defaultBoardId = config.defaultBoardId;
    this.activeConfig = { ...config };
    if (config.boardId && !this.activeConfig.boardId) {
      this.activeConfig.boardId = config.boardId;
    }
    if (this.defaultBoardId && !this.activeConfig.boardId) {
      this.activeConfig.boardId = this.defaultBoardId;
    }
    const axiosConfig = {
      baseURL: "https://api.trello.com/1",
      params: {
        key: config.apiKey,
        token: config.token
      }
    };
    const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY;
    if (proxyUrl) {
      const agent = new HttpsProxyAgent(proxyUrl);
      axiosConfig.httpAgent = agent;
      axiosConfig.httpsAgent = agent;
      axiosConfig.proxy = false;
    }
    this.axiosInstance = axios.create(axiosConfig);
    this.rateLimiter = createTrelloRateLimiters();
    this.axiosInstance.interceptors.request.use(async (config2) => {
      await this.rateLimiter.waitForAvailableToken();
      return config2;
    });
  }
  async loadConfig() {
    try {
      await fs2.mkdir(CONFIG_DIR, { recursive: true });
      const data = await fs2.readFile(CONFIG_FILE, "utf8");
      const savedConfig = JSON.parse(data);
      if (savedConfig.boardId) {
        this.activeConfig.boardId = savedConfig.boardId;
      }
      if (savedConfig.workspaceId) {
        this.activeConfig.workspaceId = savedConfig.workspaceId;
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code !== "ENOENT") {
        throw error;
      }
    }
  }
  async saveConfig() {
    try {
      await fs2.mkdir(CONFIG_DIR, { recursive: true });
      const configToSave = {
        boardId: this.activeConfig.boardId,
        workspaceId: this.activeConfig.workspaceId
      };
      await fs2.writeFile(CONFIG_FILE, JSON.stringify(configToSave, null, 2));
    } catch (error) {
      throw new Error("Failed to save configuration");
    }
  }
  get activeBoardId() {
    return this.activeConfig.boardId;
  }
  get activeWorkspaceId() {
    return this.activeConfig.workspaceId;
  }
  get hasWorkspaceRestriction() {
    return this.config.allowedWorkspaceIds !== undefined && this.config.allowedWorkspaceIds.length > 0;
  }
  isWorkspaceAllowed(workspaceId) {
    if (!this.hasWorkspaceRestriction) {
      return true;
    }
    return this.config.allowedWorkspaceIds.includes(workspaceId);
  }
  validateWorkspaceAccess(workspaceId) {
    if (!this.isWorkspaceAllowed(workspaceId)) {
      throw new McpError3(ErrorCode3.InvalidParams, `Access to workspace '${workspaceId}' is not allowed. Allowed workspaces: ${this.config.allowedWorkspaceIds.join(", ")}`);
    }
  }
  async setActiveBoard(boardId) {
    const board = await this.getBoardById(boardId);
    this.activeConfig.boardId = boardId;
    await this.saveConfig();
    return board;
  }
  async setActiveWorkspace(workspaceId) {
    this.validateWorkspaceAccess(workspaceId);
    const workspace = await this.getWorkspaceById(workspaceId);
    this.activeConfig.workspaceId = workspaceId;
    await this.saveConfig();
    return workspace;
  }
  static MAX_RETRY_ATTEMPTS = 3;
  async handleRequest(requestFn, retryCount = 0) {
    try {
      return await requestFn();
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 429 && retryCount < TrelloClient.MAX_RETRY_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, 1000 * Math.pow(2, retryCount)));
          return this.handleRequest(requestFn, retryCount + 1);
        }
        if (error.response?.status === 429) {
          throw new McpError3(ErrorCode3.InternalError, `Trello API rate limit exceeded after ${TrelloClient.MAX_RETRY_ATTEMPTS} retries`);
        }
        throw new McpError3(ErrorCode3.InternalError, `Trello API Error: ${error.response?.status} ${error.message}`, error.response?.data);
      } else {
        throw new McpError3(ErrorCode3.InternalError, "An unexpected error occurred");
      }
    }
  }
  async listBoards() {
    return this.handleRequest(async () => {
      const response = await this.axiosInstance.get("/members/me/boards");
      const boards = response.data;
      if (this.hasWorkspaceRestriction) {
        return boards.filter((board) => board.idOrganization && this.isWorkspaceAllowed(board.idOrganization));
      }
      return boards;
    });
  }
  async getBoardById(boardId) {
    return this.handleRequest(async () => {
      const response = await this.axiosInstance.get(`/boards/${boardId}`);
      return response.data;
    });
  }
  async listWorkspaces() {
    return this.handleRequest(async () => {
      const response = await this.axiosInstance.get("/members/me/organizations");
      const workspaces = response.data;
      if (this.hasWorkspaceRestriction) {
        return workspaces.filter((ws) => this.isWorkspaceAllowed(ws.id));
      }
      return workspaces;
    });
  }
  async getWorkspaceById(workspaceId) {
    return this.handleRequest(async () => {
      const response = await this.axiosInstance.get(`/organizations/${workspaceId}`);
      return response.data;
    });
  }
  async listBoardsInWorkspace(workspaceId) {
    this.validateWorkspaceAccess(workspaceId);
    return this.handleRequest(async () => {
      const response = await this.axiosInstance.get(`/organizations/${workspaceId}/boards`);
      return response.data;
    });
  }
  async createBoard(params) {
    const targetWorkspace = params.idOrganization ?? this.activeConfig.workspaceId;
    if (this.hasWorkspaceRestriction) {
      if (!targetWorkspace) {
        throw new McpError3(ErrorCode3.InvalidParams, `Workspace restrictions are enabled but no workspace was specified. Provide idOrganization or set an active workspace. Allowed workspaces: ${this.config.allowedWorkspaceIds.join(", ")}`);
      }
      this.validateWorkspaceAccess(targetWorkspace);
    }
    return this.handleRequest(async () => {
      const response = await this.axiosInstance.post("/boards", {
        name: params.name,
        desc: params.desc,
        idOrganization: targetWorkspace,
        defaultLabels: params.defaultLabels,
        defaultLists: params.defaultLists
      });
      return response.data;
    });
  }
  async getCardsByList(listId, fields, nameFilter) {
    return this.handleRequest(async () => {
      const params = fields ? { fields } : {};
      const response = await this.axiosInstance.get(`/lists/${listId}/cards`, { params });
      let cards = response.data;
      const trimmed = nameFilter?.trim();
      if (trimmed) {
        const searchTerm = trimmed.toLowerCase();
        cards = cards.filter((card) => card.name.toLowerCase().includes(searchTerm));
      }
      return cards;
    });
  }
  async getLists(boardId) {
    const effectiveBoardId = boardId || this.activeConfig.boardId || this.defaultBoardId;
    if (!effectiveBoardId) {
      throw new McpError3(ErrorCode3.InvalidParams, "boardId is required when no default board is configured");
    }
    return this.handleRequest(async () => {
      const response = await this.axiosInstance.get(`/boards/${effectiveBoardId}/lists`);
      return response.data;
    });
  }
  async getRecentActivity(boardId, limit = 10, since, before) {
    const effectiveBoardId = boardId || this.activeConfig.boardId || this.defaultBoardId;
    if (!effectiveBoardId) {
      throw new McpError3(ErrorCode3.InvalidParams, "boardId is required when no default board is configured");
    }
    return this.handleRequest(async () => {
      const params = { limit };
      if (since)
        params.since = since;
      if (before)
        params.before = before;
      const response = await this.axiosInstance.get(`/boards/${effectiveBoardId}/actions`, {
        params
      });
      return response.data;
    });
  }
  async addCard(boardId, params) {
    return this.handleRequest(async () => {
      const response = await this.axiosInstance.post("/cards", {
        idList: params.listId,
        name: params.name,
        desc: params.description,
        due: params.dueDate,
        dueReminder: params.dueReminder,
        start: params.start,
        idLabels: params.labels
      });
      return response.data;
    });
  }
  async updateCard(boardId, params) {
    return this.handleRequest(async () => {
      const response = await this.axiosInstance.put(`/cards/${params.cardId}`, {
        name: params.name,
        desc: params.description,
        due: params.dueDate,
        dueReminder: params.dueReminder,
        start: params.start,
        dueComplete: params.dueComplete,
        idLabels: params.labels,
        pos: params.pos
      });
      return response.data;
    });
  }
  async archiveCard(boardId, cardId) {
    return this.handleRequest(async () => {
      const response = await this.axiosInstance.put(`/cards/${cardId}`, {
        closed: true
      });
      return response.data;
    });
  }
  async moveCard(boardId, cardId, listId, pos) {
    const effectiveBoardId = boardId || this.defaultBoardId;
    return this.handleRequest(async () => {
      const response = await this.axiosInstance.put(`/cards/${cardId}`, {
        idList: listId,
        ...effectiveBoardId && { idBoard: effectiveBoardId },
        ...pos !== undefined && { pos }
      });
      return response.data;
    });
  }
  async addList(boardId, name) {
    const effectiveBoardId = boardId || this.activeConfig.boardId || this.defaultBoardId;
    if (!effectiveBoardId) {
      throw new McpError3(ErrorCode3.InvalidParams, "boardId is required when no default board is configured");
    }
    return this.handleRequest(async () => {
      const response = await this.axiosInstance.post("/lists", {
        name,
        idBoard: effectiveBoardId
      });
      return response.data;
    });
  }
  async archiveList(boardId, listId) {
    return this.handleRequest(async () => {
      const response = await this.axiosInstance.put(`/lists/${listId}/closed`, {
        value: true
      });
      return response.data;
    });
  }
  async updateListPosition(listId, position) {
    return this.handleRequest(async () => {
      const response = await this.axiosInstance.put(`/lists/${listId}/pos`, {
        value: position
      });
      return response.data;
    });
  }
  async updateList(listId, params) {
    return this.handleRequest(async () => {
      const response = await this.axiosInstance.put(`/lists/${listId}`, params);
      return response.data;
    });
  }
  async watchCard(cardId, subscribed) {
    return this.handleRequest(async () => {
      const response = await this.axiosInstance.put(`/cards/${cardId}`, {
        subscribed
      });
      return response.data;
    });
  }
  async watchList(listId, subscribed) {
    return this.updateList(listId, { subscribed });
  }
  async getMyCards() {
    return this.handleRequest(async () => {
      const response = await this.axiosInstance.get("/members/me/cards");
      return response.data;
    });
  }
  async attachImageToCard(boardId, cardId, imageUrl, name) {
    if (!imageUrl.startsWith("file://")) {
      validateExternalUrl(imageUrl);
    }
    return this.handleRequest(() => attachImage(this.axiosInstance, { cardId, imageUrl, name }));
  }
  async attachDataToCard(boardId, cardId, data, name, mimeType) {
    return this.handleRequest(() => attachData(this.axiosInstance, { cardId, data, name, mimeType }));
  }
  async attachImageDataToCard(boardId, cardId, imageData, name, mimeType) {
    return this.handleRequest(() => attachImageData(this.axiosInstance, { cardId, imageData, name, mimeType }));
  }
  async attachFileToCard(boardId, cardId, fileUrl, name, mimeType) {
    if (!fileUrl.startsWith("file://")) {
      validateExternalUrl(fileUrl);
    }
    return this.handleRequest(() => attachFile(this.axiosInstance, { cardId, fileUrl, name, mimeType }));
  }
  async getCard(cardId, includeMarkdown = false) {
    return this.handleRequest(async () => {
      const response = await this.axiosInstance.get(`/cards/${cardId}`, {
        params: {
          attachments: true,
          checklists: "all",
          checkItemStates: true,
          members: true,
          membersVoted: true,
          labels: true,
          actions: "commentCard",
          actions_limit: 100,
          fields: "all",
          customFieldItems: true,
          list: true,
          board: true,
          stickers: true,
          pluginData: true
        }
      });
      const cardData = response.data;
      if (includeMarkdown) {
        return this.formatCardAsMarkdown(cardData);
      }
      return cardData;
    });
  }
  async addCommentToCard(cardId, text) {
    return this.handleRequest(async () => {
      const response = await this.axiosInstance.post(`cards/${cardId}/actions/comments?text=${encodeURIComponent(text)}`);
      return response.data;
    });
  }
  async updateCommentOnCard(commentId, text) {
    return this.handleRequest(async () => {
      const response = await this.axiosInstance.put(`/actions/${commentId}?text=${encodeURIComponent(text)}`);
      if (response.status !== 200) {
        return false;
      }
      return true;
    });
  }
  async deleteCommentFromCard(commentId) {
    return this.handleRequest(async () => {
      const response = await this.axiosInstance.delete(`/actions/${commentId}`);
      return response.status === 200;
    });
  }
  async getCardComments(cardId, limit = 100) {
    return this.handleRequest(async () => {
      const response = await this.axiosInstance.get(`/cards/${cardId}/actions`, {
        params: {
          filter: "commentCard",
          limit
        }
      });
      return response.data;
    });
  }
  async getChecklistItems(name, cardId, boardId) {
    let checklists;
    if (cardId) {
      const cardResponse = await this.axiosInstance.get(`/cards/${cardId}`, {
        params: { checklists: "all" }
      });
      checklists = cardResponse.data.checklists || [];
    } else {
      const effectiveBoardId = boardId || this.activeConfig.boardId;
      if (!effectiveBoardId) {
        throw new McpError3(ErrorCode3.InvalidParams, "No board ID or card ID provided and no active board set");
      }
      const response = await this.axiosInstance.get(`/boards/${effectiveBoardId}/checklists`);
      checklists = response.data;
    }
    const allCheckItems = [];
    for (const checklist of checklists) {
      if (checklist.name.toLowerCase() === name.toLowerCase()) {
        const convertedItems = checklist.checkItems.map((item) => this.convertToCheckListItem(item, checklist.id));
        allCheckItems.push(...convertedItems);
      }
    }
    return allCheckItems;
  }
  async addChecklistItem(text, checkListName, cardId, boardId) {
    let checklists;
    if (cardId) {
      const cardResponse = await this.axiosInstance.get(`/cards/${cardId}`, {
        params: { checklists: "all" }
      });
      checklists = cardResponse.data.checklists || [];
    } else {
      const effectiveBoardId = boardId || this.activeConfig.boardId;
      if (!effectiveBoardId) {
        throw new McpError3(ErrorCode3.InvalidParams, "No board ID or card ID provided and no active board set");
      }
      const checklistsResponse = await this.axiosInstance.get(`/boards/${effectiveBoardId}/checklists`);
      checklists = checklistsResponse.data;
    }
    const targetChecklist = checklists.find((checklist) => checklist.name.toLowerCase() === checkListName.toLowerCase());
    if (!targetChecklist) {
      throw new McpError3(ErrorCode3.InvalidParams, `Checklist "${checkListName}" not found${cardId ? " on card" : " on board"}`);
    }
    const itemResponse = await this.axiosInstance.post(`/checklists/${targetChecklist.id}/checkItems`, {
      name: text
    });
    return this.convertToCheckListItem(itemResponse.data, targetChecklist.id);
  }
  async findChecklistItemsByDescription(description, cardId, boardId) {
    let checklists;
    if (cardId) {
      const cardResponse = await this.axiosInstance.get(`/cards/${cardId}`, {
        params: { checklists: "all" }
      });
      checklists = cardResponse.data.checklists || [];
    } else {
      const effectiveBoardId = boardId || this.activeConfig.boardId;
      if (!effectiveBoardId) {
        throw new McpError3(ErrorCode3.InvalidParams, "No board ID or card ID provided and no active board set");
      }
      const response = await this.axiosInstance.get(`/boards/${effectiveBoardId}/checklists`);
      checklists = response.data;
    }
    const matchingItems = [];
    const searchTerm = description.toLowerCase();
    for (const checklist of checklists) {
      for (const checkItem of checklist.checkItems) {
        if (checkItem.name.toLowerCase().includes(searchTerm)) {
          matchingItems.push(this.convertToCheckListItem(checkItem, checklist.id));
        }
      }
    }
    return matchingItems;
  }
  async getAcceptanceCriteria(cardId, boardId) {
    return this.getChecklistItems("Acceptance Criteria", cardId, boardId);
  }
  async createChecklist(name, cardId) {
    if (!cardId) {
      throw new McpError3(ErrorCode3.InvalidParams, "No card ID provided and no active card set");
    }
    const response = await this.axiosInstance.post(`/cards/${cardId}/checklists`, { name });
    return response.data;
  }
  async getChecklistByName(name, cardId, boardId) {
    let checklists;
    if (cardId) {
      const cardResponse = await this.axiosInstance.get(`/cards/${cardId}`, {
        params: { checklists: "all" }
      });
      checklists = cardResponse.data.checklists || [];
    } else {
      const effectiveBoardId = boardId || this.activeConfig.boardId;
      if (!effectiveBoardId) {
        throw new McpError3(ErrorCode3.InvalidParams, "No board ID or card ID provided and no active board set");
      }
      const response = await this.axiosInstance.get(`/boards/${effectiveBoardId}/checklists`);
      checklists = response.data;
    }
    const targetChecklist = checklists.find((checklist) => checklist.name.toLowerCase() === name.toLowerCase());
    if (targetChecklist) {
      return this.convertToCheckList(targetChecklist);
    }
    return null;
  }
  async updateChecklistItem(cardId, checkItemId, updates) {
    const normalizedUpdates = typeof updates === "string" ? { state: updates } : updates;
    const payload = Object.fromEntries(Object.entries(normalizedUpdates).filter(([, value]) => value !== undefined));
    if (Object.keys(payload).length === 0) {
      throw new McpError3(ErrorCode3.InvalidParams, "At least one checklist item field must be provided");
    }
    return this.handleRequest(async () => {
      const response = await this.axiosInstance.put(`/cards/${cardId}/checkItem/${checkItemId}`, payload);
      return response.data;
    });
  }
  async deleteChecklistItem(cardId, checkItemId) {
    return this.handleRequest(async () => {
      const response = await this.axiosInstance.delete(`/cards/${cardId}/checkItem/${checkItemId}`);
      return response.status >= 200 && response.status < 300;
    });
  }
  formatCardAsMarkdown(card) {
    let markdown = "";
    markdown += `# ${card.name}

`;
    if (card.board && card.list) {
      markdown += `\uD83D\uDCCD **Board**: [${card.board.name}](${card.board.url}) > **List**: ${card.list.name}

`;
    }
    if (card.labels && card.labels.length > 0) {
      markdown += `## \uD83C\uDFF7️ Labels
`;
      card.labels.forEach((label) => {
        markdown += `- \`${label.color}\` ${label.name || "(no name)"}
`;
      });
      markdown += `
`;
    }
    if (card.due) {
      const dueDate = new Date(card.due);
      const status = card.dueComplete ? "✅ Complete" : "⏰ Due";
      markdown += `## \uD83D\uDCC5 Due Date
${status}: ${dueDate.toLocaleString()}

`;
    }
    if (card.members && card.members.length > 0) {
      markdown += `## \uD83D\uDC65 Members
`;
      card.members.forEach((member) => {
        markdown += `- @${member.username} (${member.fullName})
`;
      });
      markdown += `
`;
    }
    if (card.desc) {
      markdown += `## \uD83D\uDCDD Description
`;
      markdown += `${card.desc}

`;
      const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
      const images = card.desc.match(imageRegex);
      if (images) {
        markdown += `### Inline Images in Description
`;
        images.forEach((img, index) => {
          const match = img.match(/!\[([^\]]*)\]\(([^)]+)\)/);
          if (match) {
            markdown += `${index + 1}. ${match[1] || "Image"}: ${match[2]}
`;
          }
        });
        markdown += `
`;
      }
    }
    if (card.checklists && card.checklists.length > 0) {
      markdown += `## ✅ Checklists
`;
      card.checklists.forEach((checklist) => {
        const completed = checklist.checkItems.filter((item) => item.state === "complete").length;
        const total = checklist.checkItems.length;
        markdown += `### ${checklist.name} (${completed}/${total})
`;
        const sortedItems = [...checklist.checkItems].sort((a, b) => a.pos - b.pos);
        sortedItems.forEach((item) => {
          const checkbox = item.state === "complete" ? "[x]" : "[ ]";
          markdown += `- ${checkbox} ${item.name}`;
          if (item.due) {
            const itemDue = new Date(item.due);
            markdown += ` (Due: ${itemDue.toLocaleDateString()})`;
          }
          if (item.idMember) {
            const member = card.members?.find((m) => m.id === item.idMember);
            if (member) {
              markdown += ` - @${member.username}`;
            }
          }
          markdown += `
`;
        });
        markdown += `
`;
      });
    }
    if (card.attachments && card.attachments.length > 0) {
      markdown += `## \uD83D\uDCCE Attachments (${card.attachments.length})
`;
      card.attachments.forEach((attachment, index) => {
        markdown += `### ${index + 1}. ${attachment.name}
`;
        markdown += `- **URL**: ${attachment.url}
`;
        if (attachment.fileName) {
          markdown += `- **File**: ${attachment.fileName}`;
          if (attachment.bytes) {
            const size = this.formatFileSize(attachment.bytes);
            markdown += ` (${size})`;
          }
          markdown += `
`;
        }
        if (attachment.mimeType) {
          markdown += `- **Type**: ${attachment.mimeType}
`;
        }
        markdown += `- **Added**: ${new Date(attachment.date).toLocaleString()}
`;
        if (attachment.previews && attachment.previews.length > 0) {
          const preview = attachment.previews[0];
          markdown += `- **Preview**: ![${attachment.name}](${preview.url})
`;
        }
        markdown += `
`;
      });
    }
    if (card.comments && card.comments.length > 0) {
      markdown += `## \uD83D\uDCAC Comments (${card.comments.length})
`;
      card.comments.forEach((comment) => {
        const date = new Date(comment.date);
        markdown += `### ${comment.memberCreator.fullName} (@${comment.memberCreator.username}) - ${date.toLocaleString()}
`;
        markdown += `${comment.data.text}

`;
      });
    }
    if (card.badges) {
      markdown += `## \uD83D\uDCCA Statistics
`;
      if (card.badges.checkItems > 0) {
        markdown += `- **Checklist Items**: ${card.badges.checkItemsChecked}/${card.badges.checkItems} completed
`;
      }
      if (card.badges.comments > 0) {
        markdown += `- **Comments**: ${card.badges.comments}
`;
      }
      if (card.badges.attachments > 0) {
        markdown += `- **Attachments**: ${card.badges.attachments}
`;
      }
      if (card.badges.votes > 0) {
        markdown += `- **Votes**: ${card.badges.votes}
`;
      }
      markdown += `
`;
    }
    markdown += `## \uD83D\uDD17 Links
`;
    markdown += `- **Card URL**: ${card.url}
`;
    markdown += `- **Short URL**: ${card.shortUrl}

`;
    markdown += `---
`;
    markdown += `*Last Activity: ${new Date(card.dateLastActivity).toLocaleString()}*
`;
    markdown += `*Card ID: ${card.id}*
`;
    return markdown;
  }
  formatFileSize(bytes) {
    const sizes = ["Bytes", "KB", "MB", "GB"];
    if (bytes === 0)
      return "0 Bytes";
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + " " + sizes[i];
  }
  convertToCheckListItem(trelloItem, parentCheckListId) {
    return {
      id: trelloItem.id,
      text: trelloItem.name,
      complete: trelloItem.state === "complete",
      parentCheckListId
    };
  }
  convertToCheckList(trelloChecklist) {
    const completedItems = trelloChecklist.checkItems.filter((item) => item.state === "complete").length;
    const totalItems = trelloChecklist.checkItems.length;
    const percentComplete = totalItems > 0 ? Math.round(completedItems / totalItems * 100) : 0;
    return {
      id: trelloChecklist.id,
      name: trelloChecklist.name,
      items: trelloChecklist.checkItems.map((item) => this.convertToCheckListItem(item, trelloChecklist.id)),
      percentComplete
    };
  }
  async getBoardMembers(boardId) {
    const effectiveBoardId = boardId || this.activeConfig.boardId || this.defaultBoardId;
    if (!effectiveBoardId) {
      throw new McpError3(ErrorCode3.InvalidParams, "boardId is required when no default board is configured");
    }
    return this.handleRequest(async () => {
      const response = await this.axiosInstance.get(`/boards/${effectiveBoardId}/members`);
      return response.data;
    });
  }
  async assignMemberToCard(cardId, memberId) {
    return this.handleRequest(async () => {
      const response = await this.axiosInstance.post(`/cards/${cardId}/idMembers`, {
        value: memberId
      });
      return response.data;
    });
  }
  async removeMemberFromCard(cardId, memberId) {
    return this.handleRequest(async () => {
      const response = await this.axiosInstance.delete(`/cards/${cardId}/idMembers/${memberId}`);
      return response.data;
    });
  }
  async getBoardLabels(boardId) {
    const effectiveBoardId = boardId || this.activeConfig.boardId || this.defaultBoardId;
    if (!effectiveBoardId) {
      throw new McpError3(ErrorCode3.InvalidParams, "boardId is required when no default board is configured");
    }
    return this.handleRequest(async () => {
      const response = await this.axiosInstance.get(`/boards/${effectiveBoardId}/labels`);
      return response.data;
    });
  }
  async createLabel(boardId, name, color) {
    const effectiveBoardId = boardId || this.activeConfig.boardId || this.defaultBoardId;
    if (!effectiveBoardId) {
      throw new McpError3(ErrorCode3.InvalidParams, "boardId is required when no default board is configured");
    }
    return this.handleRequest(async () => {
      const response = await this.axiosInstance.post(`/boards/${effectiveBoardId}/labels`, {
        name,
        color
      });
      return response.data;
    });
  }
  async updateLabel(labelId, name, color) {
    return this.handleRequest(async () => {
      const updateData = {};
      if (name !== undefined)
        updateData.name = name;
      if (color !== undefined)
        updateData.color = color;
      const response = await this.axiosInstance.put(`/labels/${labelId}`, updateData);
      return response.data;
    });
  }
  async deleteLabel(labelId) {
    return this.handleRequest(async () => {
      await this.axiosInstance.delete(`/labels/${labelId}`);
      return true;
    });
  }
  async searchLabels(boardId, query) {
    const labels = await this.getBoardLabels(boardId);
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      return [];
    }
    return labels.filter((label) => {
      const normalizedName = label.name.toLowerCase();
      const normalizedColor = label.color?.toLowerCase() ?? "";
      return normalizedName.includes(normalizedQuery) || normalizedColor.includes(normalizedQuery);
    });
  }
  async removeLabelFromCard(cardId, labelId) {
    return this.handleRequest(async () => {
      await this.axiosInstance.delete(`/cards/${cardId}/idLabels/${labelId}`);
      return true;
    });
  }
  async copyCard(params) {
    return this.handleRequest(async () => {
      const response = await this.axiosInstance.post("/cards", {
        idCardSource: params.sourceCardId,
        idList: params.listId,
        name: params.name,
        desc: params.description,
        keepFromSource: params.keepFromSource || "all",
        pos: params.pos
      });
      return response.data;
    });
  }
  async copyChecklist(params) {
    return this.handleRequest(async () => {
      const response = await this.axiosInstance.post("/checklists", {
        idCard: params.cardId,
        idChecklistSource: params.sourceChecklistId,
        name: params.name,
        pos: params.pos
      });
      return response.data;
    });
  }
  static BATCH_ADD_CARDS_LIMIT = 50;
  async batchAddCards(listId, cards) {
    if (cards.length > TrelloClient.BATCH_ADD_CARDS_LIMIT) {
      throw new McpError3(ErrorCode3.InvalidParams, `Cannot create more than ${TrelloClient.BATCH_ADD_CARDS_LIMIT} cards at once (got ${cards.length})`);
    }
    const created = [];
    const errors = [];
    for (let i = 0;i < cards.length; i++) {
      try {
        const result = await this.addCard(undefined, {
          listId,
          name: cards[i].name,
          description: cards[i].description,
          dueDate: cards[i].dueDate,
          start: cards[i].start,
          labels: cards[i].labels
        });
        created.push(result);
      } catch (error) {
        errors.push({
          index: i,
          name: cards[i].name,
          error: error instanceof Error ? error.message : "Unknown error"
        });
      }
    }
    return { created, errors };
  }
  async getBoardCustomFields(boardId) {
    const effectiveBoardId = boardId || this.activeConfig.boardId || this.defaultBoardId;
    if (!effectiveBoardId) {
      throw new McpError3(ErrorCode3.InvalidParams, "boardId is required when no default board is configured");
    }
    return this.handleRequest(async () => {
      const response = await this.axiosInstance.get(`/boards/${effectiveBoardId}/customFields`);
      return response.data;
    });
  }
  async getCustomFieldOptions(customFieldId) {
    return this.handleRequest(async () => {
      const response = await this.axiosInstance.get(`/customFields/${customFieldId}/options`);
      return response.data;
    });
  }
  async updateCardCustomField(cardId, customFieldId, params) {
    return this.handleRequest(async () => {
      let body;
      if (params.type === "clear") {
        body = { value: "", idValue: "" };
      } else if (params.type === "list") {
        body = { idValue: params.value };
      } else if (params.type === "text") {
        body = { value: { text: params.value } };
      } else if (params.type === "number") {
        body = { value: { number: params.value } };
      } else if (params.type === "checkbox") {
        body = { value: { checked: params.value } };
      } else if (params.type === "date") {
        body = { value: { date: params.value } };
      } else {
        throw new McpError3(ErrorCode3.InvalidParams, `Unknown custom field type: ${params.type}`);
      }
      const response = await this.axiosInstance.put(`/cards/${cardId}/customField/${customFieldId}/item`, body);
      return response.data;
    });
  }
  async getCardHistory(cardId, filter, limit) {
    return this.handleRequest(async () => {
      const params = {};
      if (filter)
        params.filter = filter;
      if (limit)
        params.limit = limit;
      const response = await this.axiosInstance.get(`/cards/${cardId}/actions`, { params });
      return response.data;
    });
  }
  async downloadAttachment(cardId, attachmentId) {
    return this.handleRequest(async () => {
      const metaResponse = await this.axiosInstance.get(`/cards/${cardId}/attachments/${attachmentId}`);
      const attachment = metaResponse.data;
      const downloadUrl = `https://api.trello.com/1/cards/${cardId}/attachments/${attachmentId}/download/${encodeURIComponent(attachment.fileName)}`;
      const response = await this.axiosInstance.get(downloadUrl, {
        headers: {
          Authorization: 'OAuth oauth_consumer_key="' + this.config.apiKey + '", oauth_token="' + this.config.token + '"'
        },
        responseType: "arraybuffer"
      });
      const base64Data = Buffer.from(response.data).toString("base64");
      return {
        data: base64Data,
        mimeType: attachment.mimeType || "application/octet-stream",
        fileName: attachment.fileName || "attachment"
      };
    });
  }
}

// src/health/health-monitor.ts
import { performance } from "perf_hooks";
class TrelloHealthMonitor {
  performanceTracker;
  lastHealthCheck;
  trelloClient;
  rateLimiter;
  constructor(trelloClient) {
    this.trelloClient = trelloClient;
    this.performanceTracker = {
      requests: [],
      startTime: Date.now()
    };
    this.startPerformanceMonitoring();
  }
  async getSystemHealth(detailed = false) {
    const startTime = performance.now();
    const checks = [];
    const checkPromises = [
      this.checkTrelloApiConnectivity(),
      this.checkBoardAccess(),
      this.checkRateLimitHealth(),
      this.checkPerformanceMetrics()
    ];
    if (detailed) {
      checkPromises.push(this.checkListOperations(), this.checkCardOperations(), this.checkChecklistOperations(), this.checkWorkspaceAccess());
    }
    try {
      const checkResults = await Promise.all(checkPromises);
      checks.push(...checkResults);
    } catch (error) {
      checks.push(await this.createErrorCheck("parallel_execution", error));
    }
    const overallStatus = this.calculateOverallStatus(checks);
    const recommendations = this.generateRecommendations(checks, overallStatus);
    const report = {
      overall_status: overallStatus,
      timestamp: new Date().toISOString(),
      checks,
      recommendations,
      repair_available: this.isRepairAvailable(checks),
      uptime_ms: Date.now() - this.performanceTracker.startTime,
      performance_metrics: this.calculatePerformanceMetrics()
    };
    this.lastHealthCheck = report;
    return report;
  }
  async checkTrelloApiConnectivity() {
    const startTime = performance.now();
    const checkName = "trello_api_connectivity";
    try {
      await this.trelloClient.listBoards();
      const duration = performance.now() - startTime;
      this.recordPerformanceMetric(duration, true);
      return {
        name: checkName,
        status: "healthy" /* HEALTHY */,
        message: "Trello API connectivity is excellent",
        duration_ms: Math.round(duration),
        timestamp: new Date().toISOString(),
        metadata: {
          endpoint: "/members/me/boards",
          response_time_category: this.categorizeResponseTime(duration)
        }
      };
    } catch (error) {
      const duration = performance.now() - startTime;
      this.recordPerformanceMetric(duration, false);
      return this.createErrorCheck(checkName, error, duration);
    }
  }
  async checkBoardAccess() {
    const startTime = performance.now();
    const checkName = "board_access";
    try {
      const boardId = this.trelloClient.activeBoardId;
      if (!boardId) {
        return {
          name: checkName,
          status: "degraded" /* DEGRADED */,
          message: "No active board configured",
          duration_ms: Math.round(performance.now() - startTime),
          timestamp: new Date().toISOString(),
          metadata: {
            suggestion: "Set an active board using set_active_board tool"
          }
        };
      }
      const board = await this.trelloClient.getBoardById(boardId);
      const duration = performance.now() - startTime;
      this.recordPerformanceMetric(duration, true);
      return {
        name: checkName,
        status: board.closed ? "critical" /* CRITICAL */ : "healthy" /* HEALTHY */,
        message: board.closed ? "Active board is closed/archived" : `Board "${board.name}" is accessible`,
        duration_ms: Math.round(duration),
        timestamp: new Date().toISOString(),
        metadata: {
          board_id: board.id,
          board_name: board.name,
          board_closed: board.closed,
          board_url: board.url
        }
      };
    } catch (error) {
      const duration = performance.now() - startTime;
      this.recordPerformanceMetric(duration, false);
      return this.createErrorCheck(checkName, error, duration);
    }
  }
  async checkRateLimitHealth() {
    const startTime = performance.now();
    const checkName = "rate_limit_health";
    try {
      const rateLimiterInfo = {
        can_make_request: true,
        utilization_percent: this.calculateRateLimitUtilization()
      };
      const duration = performance.now() - startTime;
      let status = "healthy" /* HEALTHY */;
      let message = "Rate limiting is functioning optimally";
      if (rateLimiterInfo.utilization_percent > 80) {
        status = "degraded" /* DEGRADED */;
        message = "High rate limit utilization detected";
      } else if (rateLimiterInfo.utilization_percent > 95) {
        status = "critical" /* CRITICAL */;
        message = "Rate limit near exhaustion";
      }
      return {
        name: checkName,
        status,
        message,
        duration_ms: Math.round(duration),
        timestamp: new Date().toISOString(),
        metadata: {
          utilization_percent: rateLimiterInfo.utilization_percent,
          can_make_request: rateLimiterInfo.can_make_request,
          trello_limits: {
            api_key_limit: "300 requests / 10 seconds",
            token_limit: "100 requests / 10 seconds"
          }
        }
      };
    } catch (error) {
      const duration = performance.now() - startTime;
      return this.createErrorCheck(checkName, error, duration);
    }
  }
  async checkPerformanceMetrics() {
    const startTime = performance.now();
    const checkName = "performance_metrics";
    try {
      const metrics = this.calculatePerformanceMetrics();
      const duration = performance.now() - startTime;
      let status = "healthy" /* HEALTHY */;
      let message = "Performance metrics are excellent";
      if (metrics.avg_response_time_ms > 2000) {
        status = "degraded" /* DEGRADED */;
        message = "Slower than optimal response times detected";
      } else if (metrics.success_rate_percent < 95) {
        status = "critical" /* CRITICAL */;
        message = "Low success rate detected";
      }
      return {
        name: checkName,
        status,
        message,
        duration_ms: Math.round(duration),
        timestamp: new Date().toISOString(),
        metadata: {
          ...metrics,
          total_requests: this.performanceTracker.requests.length
        }
      };
    } catch (error) {
      const duration = performance.now() - startTime;
      return this.createErrorCheck(checkName, error, duration);
    }
  }
  async checkListOperations() {
    const startTime = performance.now();
    const checkName = "list_operations";
    try {
      const lists = await this.trelloClient.getLists();
      const duration = performance.now() - startTime;
      this.recordPerformanceMetric(duration, true);
      return {
        name: checkName,
        status: "healthy" /* HEALTHY */,
        message: `Successfully retrieved ${lists.length} lists`,
        duration_ms: Math.round(duration),
        timestamp: new Date().toISOString(),
        metadata: {
          total_lists: lists.length,
          open_lists: lists.filter((l) => !l.closed).length,
          closed_lists: lists.filter((l) => l.closed).length
        }
      };
    } catch (error) {
      const duration = performance.now() - startTime;
      this.recordPerformanceMetric(duration, false);
      return this.createErrorCheck(checkName, error, duration);
    }
  }
  async checkCardOperations() {
    const startTime = performance.now();
    const checkName = "card_operations";
    try {
      const myCards = await this.trelloClient.getMyCards();
      const duration = performance.now() - startTime;
      this.recordPerformanceMetric(duration, true);
      return {
        name: checkName,
        status: "healthy" /* HEALTHY */,
        message: `Successfully retrieved ${myCards.length} user cards`,
        duration_ms: Math.round(duration),
        timestamp: new Date().toISOString(),
        metadata: {
          total_cards: myCards.length,
          open_cards: myCards.filter((c) => !c.closed).length,
          closed_cards: myCards.filter((c) => c.closed).length
        }
      };
    } catch (error) {
      const duration = performance.now() - startTime;
      this.recordPerformanceMetric(duration, false);
      return this.createErrorCheck(checkName, error, duration);
    }
  }
  async checkChecklistOperations() {
    const startTime = performance.now();
    const checkName = "checklist_operations";
    try {
      const criteria = await this.trelloClient.getAcceptanceCriteria();
      const duration = performance.now() - startTime;
      this.recordPerformanceMetric(duration, true);
      return {
        name: checkName,
        status: "healthy" /* HEALTHY */,
        message: `Checklist operations functioning (${criteria.length} acceptance criteria found)`,
        duration_ms: Math.round(duration),
        timestamp: new Date().toISOString(),
        metadata: {
          acceptance_criteria_count: criteria.length,
          completed_items: criteria.filter((item) => item.complete).length
        }
      };
    } catch (error) {
      const duration = performance.now() - startTime;
      this.recordPerformanceMetric(duration, false);
      const isConfigError = error instanceof Error && (error.message.includes("not found") || error.message.includes("No board ID"));
      return this.createErrorCheck(checkName, error, duration, isConfigError ? "degraded" /* DEGRADED */ : "critical" /* CRITICAL */);
    }
  }
  async checkWorkspaceAccess() {
    const startTime = performance.now();
    const checkName = "workspace_access";
    try {
      const workspaces = await this.trelloClient.listWorkspaces();
      const duration = performance.now() - startTime;
      this.recordPerformanceMetric(duration, true);
      return {
        name: checkName,
        status: "healthy" /* HEALTHY */,
        message: `Access to ${workspaces.length} workspaces confirmed`,
        duration_ms: Math.round(duration),
        timestamp: new Date().toISOString(),
        metadata: {
          total_workspaces: workspaces.length,
          active_workspace_id: this.trelloClient.activeWorkspaceId,
          workspace_names: workspaces.map((w) => w.displayName)
        }
      };
    } catch (error) {
      const duration = performance.now() - startTime;
      this.recordPerformanceMetric(duration, false);
      return this.createErrorCheck(checkName, error, duration);
    }
  }
  calculateOverallStatus(checks) {
    if (checks.some((c) => c.status === "critical" /* CRITICAL */)) {
      return "critical" /* CRITICAL */;
    }
    if (checks.some((c) => c.status === "degraded" /* DEGRADED */)) {
      return "degraded" /* DEGRADED */;
    }
    if (checks.every((c) => c.status === "healthy" /* HEALTHY */)) {
      return "healthy" /* HEALTHY */;
    }
    return "unknown" /* UNKNOWN */;
  }
  generateRecommendations(checks, overallStatus) {
    const recommendations = [];
    const boardCheck = checks.find((c) => c.name === "board_access");
    if (boardCheck?.status === "degraded" /* DEGRADED */ && boardCheck.metadata?.suggestion) {
      recommendations.push(boardCheck.metadata.suggestion);
    }
    const rateLimitCheck = checks.find((c) => c.name === "rate_limit_health");
    if (rateLimitCheck?.status === "degraded" /* DEGRADED */) {
      recommendations.push("Consider implementing request throttling or caching to reduce API usage");
    }
    const performanceCheck = checks.find((c) => c.name === "performance_metrics");
    if (performanceCheck?.status === "degraded" /* DEGRADED */) {
      recommendations.push("Investigate slow response times - consider network conditions or API load");
    }
    if (overallStatus === "healthy" /* HEALTHY */) {
      recommendations.push("All systems operating normally - maintain current configuration");
    } else if (overallStatus === "critical" /* CRITICAL */) {
      recommendations.push("Immediate attention required - check error logs and connectivity");
    }
    return recommendations.length > 0 ? recommendations : ["System assessment complete - no specific recommendations"];
  }
  isRepairAvailable(checks) {
    return checks.some((c) => c.status === "degraded" /* DEGRADED */) && !checks.some((c) => c.status === "critical" /* CRITICAL */);
  }
  createErrorCheck(checkName, error, duration, status = "critical" /* CRITICAL */) {
    let message = "Unknown error occurred";
    let errorCode;
    if (error instanceof Error) {
      message = error.message;
    }
    if (error && typeof error === "object" && "response" in error) {
      const axiosError = error;
      errorCode = axiosError.response?.status?.toString();
      message = `HTTP ${axiosError.response?.status}: ${axiosError.message}`;
    }
    return {
      name: checkName,
      status,
      message,
      duration_ms: Math.round(duration || 0),
      timestamp: new Date().toISOString(),
      metadata: {
        error_type: error?.constructor?.name || "Unknown",
        error_code: errorCode,
        error_details: error instanceof Error ? error.stack : undefined
      }
    };
  }
  recordPerformanceMetric(duration, success) {
    const now = Date.now();
    this.performanceTracker.requests.push({ timestamp: now, duration, success });
    if (this.performanceTracker.requests.length > 100) {
      this.performanceTracker.requests = this.performanceTracker.requests.slice(-100);
    }
  }
  calculatePerformanceMetrics() {
    const requests = this.performanceTracker.requests;
    if (requests.length === 0) {
      return {
        avg_response_time_ms: 0,
        success_rate_percent: 100,
        rate_limit_utilization_percent: 0,
        requests_per_minute: 0
      };
    }
    const avgResponseTime = requests.reduce((sum, r) => sum + r.duration, 0) / requests.length;
    const successRate = requests.filter((r) => r.success).length / requests.length * 100;
    const oneMinuteAgo = Date.now() - 60000;
    const recentRequests = requests.filter((r) => r.timestamp > oneMinuteAgo);
    const requestsPerMinute = recentRequests.length;
    return {
      avg_response_time_ms: Math.round(avgResponseTime),
      success_rate_percent: Math.round(successRate * 100) / 100,
      rate_limit_utilization_percent: this.calculateRateLimitUtilization(),
      requests_per_minute: requestsPerMinute
    };
  }
  calculateRateLimitUtilization() {
    const requests = this.performanceTracker.requests;
    const tenSecondsAgo = Date.now() - 1e4;
    const recentRequests = requests.filter((r) => r.timestamp > tenSecondsAgo).length;
    return Math.min(100, recentRequests / 100 * 100);
  }
  categorizeResponseTime(duration) {
    if (duration < 200)
      return "excellent";
    if (duration < 500)
      return "good";
    if (duration < 1000)
      return "fair";
    if (duration < 2000)
      return "slow";
    return "very_slow";
  }
  startPerformanceMonitoring() {
    setInterval(() => {
      const fiveMinutesAgo = Date.now() - 300000;
      this.performanceTracker.requests = this.performanceTracker.requests.filter((r) => r.timestamp > fiveMinutesAgo);
    }, 60000);
  }
  getLastHealthCheck() {
    return this.lastHealthCheck;
  }
}

// src/health/health-endpoints.ts
class TrelloHealthEndpoints {
  healthMonitor;
  trelloClient;
  constructor(trelloClient) {
    this.trelloClient = trelloClient;
    this.healthMonitor = new TrelloHealthMonitor(trelloClient);
  }
  async getBasicHealth() {
    try {
      const healthReport = await this.healthMonitor.getSystemHealth(false);
      const quickReport = {
        status: healthReport.overall_status,
        timestamp: healthReport.timestamp,
        uptime_ms: healthReport.uptime_ms,
        checks_passed: healthReport.checks.filter((c) => c.status === "healthy" /* HEALTHY */).length,
        total_checks: healthReport.checks.length,
        response_time_ms: Math.round(healthReport.performance_metrics.avg_response_time_ms),
        success_rate: `${healthReport.performance_metrics.success_rate_percent}%`
      };
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(quickReport, null, 2)
          }
        ],
        isError: healthReport.overall_status === "critical" /* CRITICAL */
      };
    } catch (error) {
      return this.createErrorResponse("Health check failed", error);
    }
  }
  async getDetailedHealth() {
    try {
      const healthReport = await this.healthMonitor.getSystemHealth(true);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(healthReport, null, 2)
          }
        ],
        isError: healthReport.overall_status === "critical" /* CRITICAL */
      };
    } catch (error) {
      return this.createErrorResponse("Detailed health check failed", error);
    }
  }
  async getMetadataHealth() {
    try {
      const startTime = Date.now();
      const metadataReport = await this.performMetadataConsistencyCheck();
      const duration = Date.now() - startTime;
      const result = {
        status: metadataReport.consistent ? "healthy" /* HEALTHY */ : "degraded" /* DEGRADED */,
        timestamp: new Date().toISOString(),
        duration_ms: duration,
        metadata_consistency: metadataReport,
        recommendations: this.generateMetadataRecommendations(metadataReport)
      };
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2)
          }
        ],
        isError: !metadataReport.consistent
      };
    } catch (error) {
      return this.createErrorResponse("Metadata health check failed", error);
    }
  }
  async getPerformanceHealth() {
    try {
      const healthReport = await this.healthMonitor.getSystemHealth(false);
      const performanceAnalysis = this.analyzePerformanceMetrics(healthReport);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(performanceAnalysis, null, 2)
          }
        ],
        isError: performanceAnalysis.status === "critical" /* CRITICAL */
      };
    } catch (error) {
      return this.createErrorResponse("Performance health check failed", error);
    }
  }
  async performRepair() {
    try {
      const healthReport = await this.healthMonitor.getSystemHealth(true);
      if (!healthReport.repair_available) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                repair_attempted: false,
                reason: "No repairable issues detected or system in critical state",
                status: healthReport.overall_status,
                recommendations: healthReport.recommendations
              }, null, 2)
            }
          ]
        };
      }
      const repairResult = await this.attemptSystemRepair(healthReport);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(repairResult, null, 2)
          }
        ],
        isError: !repairResult.success
      };
    } catch (error) {
      return this.createErrorResponse("System repair failed", error);
    }
  }
  async performMetadataConsistencyCheck() {
    const results = {
      consistent: true,
      issues: [],
      statistics: {},
      last_check: new Date().toISOString()
    };
    try {
      const boardId = this.trelloClient.activeBoardId;
      if (!boardId) {
        results.consistent = false;
        results.issues.push("No active board configured");
        return results;
      }
      const board = await this.trelloClient.getBoardById(boardId);
      if (board.closed) {
        results.consistent = false;
        results.issues.push("Active board is closed/archived");
      }
      const lists = await this.trelloClient.getLists();
      results.statistics.total_lists = lists.length;
      results.statistics.open_lists = lists.filter((l) => !l.closed).length;
      results.statistics.closed_lists = lists.filter((l) => l.closed).length;
      if (lists.length === 0) {
        results.issues.push("Board has no lists");
      }
      const myCards = await this.trelloClient.getMyCards();
      results.statistics.total_user_cards = myCards.length;
      results.statistics.open_user_cards = myCards.filter((c) => !c.closed).length;
      const workspaceId = this.trelloClient.activeWorkspaceId;
      if (workspaceId) {
        try {
          const workspace = await this.trelloClient.getWorkspaceById(workspaceId);
          results.statistics.active_workspace = workspace.displayName;
        } catch (error) {
          results.consistent = false;
          results.issues.push("Active workspace is inaccessible");
        }
      }
      try {
        const acceptanceCriteria = await this.trelloClient.getAcceptanceCriteria();
        results.statistics.acceptance_criteria_items = acceptanceCriteria.length;
      } catch (error) {
        results.statistics.checklist_note = "Acceptance Criteria checklist not found (non-critical)";
      }
    } catch (error) {
      results.consistent = false;
      results.issues.push(`Metadata check error: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
    return results;
  }
  generateMetadataRecommendations(metadataReport) {
    const recommendations = [];
    if (metadataReport.issues.some((issue) => issue.includes("No active board"))) {
      recommendations.push("Use set_active_board tool to configure an active board");
    }
    if (metadataReport.issues.some((issue) => issue.includes("closed/archived"))) {
      recommendations.push("Set a different active board that is not closed/archived");
    }
    if (metadataReport.issues.some((issue) => issue.includes("no lists"))) {
      recommendations.push("Create lists in your board using add_list_to_board tool");
    }
    if (metadataReport.statistics.total_user_cards === 0) {
      recommendations.push("Consider assigning yourself to some cards for better workflow tracking");
    }
    if (recommendations.length === 0) {
      recommendations.push("Metadata consistency is excellent - no action required");
    }
    return recommendations;
  }
  analyzePerformanceMetrics(healthReport) {
    const metrics = healthReport.performance_metrics;
    const performanceGrade = this.calculatePerformanceGrade(metrics);
    return {
      status: this.getPerformanceStatus(performanceGrade),
      timestamp: healthReport.timestamp,
      performance_grade: performanceGrade,
      metrics: {
        ...metrics,
        uptime_hours: Math.round(healthReport.uptime_ms / (1000 * 60 * 60) * 100) / 100,
        health_check_duration_ms: healthReport.checks.reduce((sum, c) => sum + c.duration_ms, 0)
      },
      analysis: {
        response_time_rating: this.rateResponseTime(metrics.avg_response_time_ms),
        success_rate_rating: this.rateSuccessRate(metrics.success_rate_percent),
        throughput_rating: this.rateThroughput(metrics.requests_per_minute),
        rate_limit_health: this.rateRateLimitUtilization(metrics.rate_limit_utilization_percent)
      },
      recommendations: this.generatePerformanceRecommendations(metrics)
    };
  }
  calculatePerformanceGrade(metrics) {
    let score = 0;
    if (metrics.avg_response_time_ms < 200)
      score += 40;
    else if (metrics.avg_response_time_ms < 500)
      score += 35;
    else if (metrics.avg_response_time_ms < 1000)
      score += 25;
    else if (metrics.avg_response_time_ms < 2000)
      score += 15;
    else
      score += 5;
    if (metrics.success_rate_percent >= 99)
      score += 35;
    else if (metrics.success_rate_percent >= 95)
      score += 30;
    else if (metrics.success_rate_percent >= 90)
      score += 20;
    else if (metrics.success_rate_percent >= 80)
      score += 10;
    else
      score += 5;
    if (metrics.rate_limit_utilization_percent < 50)
      score += 25;
    else if (metrics.rate_limit_utilization_percent < 70)
      score += 20;
    else if (metrics.rate_limit_utilization_percent < 85)
      score += 15;
    else if (metrics.rate_limit_utilization_percent < 95)
      score += 10;
    else
      score += 5;
    if (score >= 90)
      return "A+";
    if (score >= 80)
      return "A";
    if (score >= 70)
      return "B";
    if (score >= 60)
      return "C";
    if (score >= 50)
      return "D";
    return "F";
  }
  getPerformanceStatus(grade) {
    if (["A+", "A", "B"].includes(grade))
      return "healthy" /* HEALTHY */;
    if (["C", "D"].includes(grade))
      return "degraded" /* DEGRADED */;
    return "critical" /* CRITICAL */;
  }
  rateResponseTime(avgMs) {
    if (avgMs < 200)
      return "excellent";
    if (avgMs < 500)
      return "good";
    if (avgMs < 1000)
      return "fair";
    if (avgMs < 2000)
      return "slow";
    return "very_slow";
  }
  rateSuccessRate(percent) {
    if (percent >= 99)
      return "excellent";
    if (percent >= 95)
      return "good";
    if (percent >= 90)
      return "fair";
    if (percent >= 80)
      return "poor";
    return "critical";
  }
  rateThroughput(requestsPerMin) {
    if (requestsPerMin > 30)
      return "high";
    if (requestsPerMin > 15)
      return "moderate";
    if (requestsPerMin > 5)
      return "low";
    return "very_low";
  }
  rateRateLimitUtilization(percent) {
    if (percent < 50)
      return "optimal";
    if (percent < 70)
      return "moderate";
    if (percent < 85)
      return "high";
    if (percent < 95)
      return "near_limit";
    return "critical";
  }
  generatePerformanceRecommendations(metrics) {
    const recommendations = [];
    if (metrics.avg_response_time_ms > 1000) {
      recommendations.push("High response times detected - check network connectivity and Trello API status");
    }
    if (metrics.success_rate_percent < 95) {
      recommendations.push("Low success rate - investigate error patterns and implement retry logic");
    }
    if (metrics.rate_limit_utilization_percent > 80) {
      recommendations.push("High rate limit utilization - consider implementing request caching or batching");
    }
    if (metrics.requests_per_minute < 1) {
      recommendations.push("Very low API usage - ensure the MCP server is being actively used");
    }
    if (recommendations.length === 0) {
      recommendations.push("Performance is excellent - maintain current usage patterns");
    }
    return recommendations;
  }
  async attemptSystemRepair(healthReport) {
    const result = {
      attempted: true,
      success: false,
      actions_taken: [],
      message: ""
    };
    try {
      const boardCheck = healthReport.checks.find((c) => c.name === "board_access");
      if (boardCheck?.status === "degraded" /* DEGRADED */ && boardCheck.message.includes("No active board configured")) {
        const boards = await this.trelloClient.listBoards();
        const openBoards = boards.filter((b) => !b.closed);
        if (openBoards.length > 0) {
          await this.trelloClient.setActiveBoard(openBoards[0].id);
          result.actions_taken.push(`Set active board to "${openBoards[0].name}"`);
        }
      }
      result.success = result.actions_taken.length > 0;
      result.message = result.success ? "System repair completed successfully" : "No repairable issues found";
    } catch (error) {
      result.success = false;
      result.message = `Repair failed: ${error instanceof Error ? error.message : "Unknown error"}`;
    }
    return result;
  }
  createErrorResponse(message, error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: message,
            details: errorMessage,
            timestamp: new Date().toISOString(),
            status: "critical" /* CRITICAL */
          }, null, 2)
        }
      ],
      isError: true
    };
  }
}
var HealthEndpointSchemas = {
  basicHealth: {
    title: "Get Basic Health",
    description: "Get quick system health status for monitoring and load balancing",
    inputSchema: {}
  },
  detailedHealth: {
    title: "Get Detailed Health",
    description: "Get comprehensive system health diagnostic with all subsystem checks",
    inputSchema: {}
  },
  metadataHealth: {
    title: "Get Metadata Health",
    description: "Verify metadata consistency between boards, lists, cards, and checklists",
    inputSchema: {}
  },
  performanceHealth: {
    title: "Get Performance Health",
    description: "Get detailed performance metrics and analysis",
    inputSchema: {}
  },
  repair: {
    title: "Perform System Repair",
    description: "Attempt to automatically repair common system issues",
    inputSchema: {}
  }
};

// src/card-list-preview.ts
var DEFAULT_DESC_MAX_LENGTH = 200;
var DEFAULT_OMIT_DESC_THRESHOLD_BYTES = 50000;
function formatCardListResponse(cards, options = {}) {
  const descMaxLength = options.descMaxLength ?? DEFAULT_DESC_MAX_LENGTH;
  const omitDescThresholdBytes = options.omitDescThresholdBytes ?? DEFAULT_OMIT_DESC_THRESHOLD_BYTES;
  let anyTruncated = false;
  const previewCards = cards.map((card) => {
    if (!card.desc || card.desc.length <= descMaxLength) {
      return card;
    }
    anyTruncated = true;
    const suffix = descMaxLength >= 3 ? "..." : "";
    const sliceLength = Math.max(0, descMaxLength - suffix.length);
    return { ...card, desc: `${card.desc.slice(0, sliceLength)}${suffix}` };
  });
  let resultCards = previewCards;
  let descriptionsOmitted = false;
  let result = JSON.stringify(resultCards, null, 2);
  if (Buffer.byteLength(result, "utf8") > omitDescThresholdBytes) {
    resultCards = cards.map(({ desc, ...rest }) => rest);
    result = JSON.stringify(resultCards, null, 2);
    descriptionsOmitted = true;
  }
  const content = [{ type: "text", text: result }];
  if (descriptionsOmitted) {
    content.push({
      type: "text",
      text: "Descriptions omitted due to response size. Use get_card with a specific cardId for full details, or request fields without desc when listing cards."
    });
  } else if (anyTruncated) {
    content.push({
      type: "text",
      text: "Some descriptions were truncated. Use get_card with a specific cardId for full details, or increase descMaxLength for a longer preview."
    });
  }
  return { content };
}

// src/index.ts
class TrelloServer {
  server;
  trelloClient;
  healthEndpoints;
  constructor() {
    const apiKey = process.env.TRELLO_API_KEY;
    const token = process.env.TRELLO_TOKEN;
    const defaultBoardId = process.env.TRELLO_BOARD_ID;
    const allowedWorkspacesEnv = process.env.TRELLO_ALLOWED_WORKSPACES;
    if (!apiKey || !token) {
      throw new Error("TRELLO_API_KEY and TRELLO_TOKEN environment variables are required");
    }
    const allowedWorkspaceIds = allowedWorkspacesEnv ? allowedWorkspacesEnv.split(",").map((id) => id.trim()).filter((id) => id.length > 0) : undefined;
    this.trelloClient = new TrelloClient({
      apiKey,
      token,
      defaultBoardId,
      boardId: defaultBoardId,
      allowedWorkspaceIds
    });
    this.healthEndpoints = new TrelloHealthEndpoints(this.trelloClient);
    this.server = new McpServer({
      name: "trello-server",
      version: "1.8.1"
    });
    this.setupTools();
    this.setupHealthEndpoints();
    process.on("SIGINT", async () => {
      await this.server.close();
      process.exit(0);
    });
  }
  handleError(error) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : "Unknown error occurred"}`
        }
      ],
      isError: true
    };
  }
  setupTools() {
    this.server.registerTool("get_cards_by_list_id", {
      title: "Get Cards by List ID",
      description: 'Fetch cards from a specific Trello list on a specific board. Descriptions are previewed by default to keep responses compact; set fields without "desc" to omit descriptions, or increase descMaxLength/omitDescThresholdBytes and use get_card for full details.',
      inputSchema: {
        boardId: z.string().optional().describe("ID of the Trello board (uses default if not provided)"),
        listId: z.string().describe("ID of the Trello list"),
        fields: z.string().optional().describe('Comma-separated list of fields to return (e.g., "name,idShort,labels,due,dueComplete"). Omit for all fields.'),
        nameFilter: z.string().trim().min(1, "nameFilter must not be empty").optional().describe("Optional substring to filter cards by name (case-insensitive)"),
        descMaxLength: z.number().int().min(0).optional().describe("Maximum description preview length per card. Defaults to 200. Increase for fuller descriptions."),
        omitDescThresholdBytes: z.number().int().positive().optional().describe("Approximate response size threshold before descriptions are omitted. Defaults to 50000 bytes.")
      }
    }, async ({ listId, fields, nameFilter, descMaxLength, omitDescThresholdBytes }) => {
      try {
        const cards = await this.trelloClient.getCardsByList(listId, fields, nameFilter);
        return formatCardListResponse(cards, { descMaxLength, omitDescThresholdBytes });
      } catch (error) {
        return this.handleError(error);
      }
    });
    this.server.registerTool("get_lists", {
      title: "Get Lists",
      description: "Retrieve all lists from the specified board",
      inputSchema: {
        boardId: z.string().optional().describe("ID of the Trello board (uses default if not provided)")
      }
    }, async ({ boardId }) => {
      try {
        const lists = await this.trelloClient.getLists(boardId);
        return {
          content: [{ type: "text", text: JSON.stringify(lists, null, 2) }]
        };
      } catch (error) {
        return this.handleError(error);
      }
    });
    this.server.registerTool("get_recent_activity", {
      title: "Get Recent Activity",
      description: "Fetch recent activity on the Trello board",
      inputSchema: {
        boardId: z.string().optional().describe("ID of the Trello board (uses default if not provided)"),
        limit: z.number().optional().default(10).describe("Number of activities to fetch (default: 10)"),
        since: z.string().optional().describe("Only return actions after this date (ISO 8601) or action ID"),
        before: z.string().optional().describe("Only return actions before this date (ISO 8601) or action ID")
      }
    }, async ({ boardId, limit, since, before }) => {
      try {
        const activity = await this.trelloClient.getRecentActivity(boardId, limit, since, before);
        return {
          content: [{ type: "text", text: JSON.stringify(activity, null, 2) }]
        };
      } catch (error) {
        return this.handleError(error);
      }
    });
    this.server.registerTool("add_card_to_list", {
      title: "Add Card to List",
      description: "Add a new card to a specified list on a specific board",
      inputSchema: {
        boardId: z.string().optional().describe("ID of the Trello board (uses default if not provided)"),
        listId: z.string().describe("ID of the list to add the card to"),
        name: z.string().describe("Name of the card"),
        description: z.string().optional().describe("Description of the card"),
        dueDate: z.string().optional().describe("Due date for the card (ISO 8601 format)"),
        dueReminder: z.number().int().nullable().optional().describe("Due date reminder in minutes before due date (e.g., null to remove reminder, 0 at due time, 1440 one day before)"),
        start: z.string().optional().describe("Start date for the card (YYYY-MM-DD format, date only)"),
        labels: z.array(z.string()).optional().describe("Array of label IDs to apply to the card")
      }
    }, async (args) => {
      try {
        const card = await this.trelloClient.addCard(args.boardId, args);
        return {
          content: [{ type: "text", text: JSON.stringify(card, null, 2) }]
        };
      } catch (error) {
        return this.handleError(error);
      }
    });
    this.server.registerTool("update_card_details", {
      title: "Update Card Details",
      description: "Update an existing card's details on a specific board",
      inputSchema: {
        boardId: z.string().optional().describe("ID of the Trello board (uses default if not provided)"),
        cardId: z.string().describe("ID of the card to update"),
        name: z.string().optional().describe("New name for the card"),
        description: z.string().optional().describe("New description for the card"),
        dueDate: z.string().optional().describe("New due date for the card (ISO 8601 format)"),
        dueReminder: z.number().int().nullable().optional().describe("New due date reminder in minutes before due date (e.g., null to remove reminder, 0 at due time, 1440 one day before)"),
        start: z.string().optional().describe("New start date for the card (YYYY-MM-DD format, date only)"),
        dueComplete: z.boolean().optional().describe("Mark the due date as complete (true) or incomplete (false)"),
        labels: z.array(z.string()).optional().describe("New array of label IDs for the card"),
        pos: z.union([z.string(), z.number()]).optional().describe('Position of the card in the list. Accepts "top", "bottom", or a positive number')
      }
    }, async (args) => {
      try {
        const card = await this.trelloClient.updateCard(args.boardId, args);
        return {
          content: [{ type: "text", text: JSON.stringify(card, null, 2) }]
        };
      } catch (error) {
        return this.handleError(error);
      }
    });
    this.server.registerTool("archive_card", {
      title: "Archive Card",
      description: "Send a card to the archive on a specific board",
      inputSchema: {
        boardId: z.string().optional().describe("ID of the Trello board (uses default if not provided)"),
        cardId: z.string().describe("ID of the card to archive")
      }
    }, async ({ boardId, cardId }) => {
      try {
        const card = await this.trelloClient.archiveCard(boardId, cardId);
        return {
          content: [{ type: "text", text: JSON.stringify(card, null, 2) }]
        };
      } catch (error) {
        return this.handleError(error);
      }
    });
    this.server.registerTool("watch_card", {
      title: "Watch Card",
      description: "Subscribe or unsubscribe from watching a card for activity notifications",
      inputSchema: {
        cardId: z.string().describe("ID of the card to watch/unwatch"),
        subscribed: z.boolean().describe("Set to true to start watching, false to stop")
      }
    }, async ({ cardId, subscribed }) => {
      try {
        const card = await this.trelloClient.watchCard(cardId, subscribed);
        return {
          content: [{ type: "text", text: JSON.stringify(card, null, 2) }]
        };
      } catch (error) {
        return this.handleError(error);
      }
    });
    this.server.registerTool("watch_list", {
      title: "Watch List",
      description: "Subscribe or unsubscribe from watching a list for activity notifications",
      inputSchema: {
        listId: z.string().describe("ID of the list to watch/unwatch"),
        subscribed: z.boolean().describe("Set to true to start watching, false to stop")
      }
    }, async ({ listId, subscribed }) => {
      try {
        const list = await this.trelloClient.watchList(listId, subscribed);
        return {
          content: [{ type: "text", text: JSON.stringify(list, null, 2) }]
        };
      } catch (error) {
        return this.handleError(error);
      }
    });
    this.server.registerTool("move_card", {
      title: "Move Card",
      description: "Move a card to a different list, potentially on a different board",
      inputSchema: {
        boardId: z.string().optional().describe("ID of the target Trello board (where the listId resides, uses default if not provided)"),
        cardId: z.string().describe("ID of the card to move"),
        listId: z.string().describe("ID of the target list"),
        pos: z.union([z.string(), z.number()]).optional().describe('Position of the card in the target list. Accepts "top", "bottom", or a positive number')
      }
    }, async ({ boardId, cardId, listId, pos }) => {
      try {
        const card = await this.trelloClient.moveCard(boardId, cardId, listId, pos);
        return {
          content: [{ type: "text", text: JSON.stringify(card, null, 2) }]
        };
      } catch (error) {
        return this.handleError(error);
      }
    });
    this.server.registerTool("add_list_to_board", {
      title: "Add List to Board",
      description: "Add a new list to the specified board",
      inputSchema: {
        boardId: z.string().optional().describe("ID of the Trello board (uses default if not provided)"),
        name: z.string().describe("Name of the new list")
      }
    }, async ({ boardId, name }) => {
      try {
        const list = await this.trelloClient.addList(boardId, name);
        return {
          content: [{ type: "text", text: JSON.stringify(list, null, 2) }]
        };
      } catch (error) {
        return this.handleError(error);
      }
    });
    this.server.registerTool("archive_list", {
      title: "Archive List",
      description: "Send a list to the archive on a specific board",
      inputSchema: {
        boardId: z.string().optional().describe("ID of the Trello board (uses default if not provided)"),
        listId: z.string().describe("ID of the list to archive")
      }
    }, async ({ boardId, listId }) => {
      try {
        const list = await this.trelloClient.archiveList(boardId, listId);
        return {
          content: [{ type: "text", text: JSON.stringify(list, null, 2) }]
        };
      } catch (error) {
        return this.handleError(error);
      }
    });
    this.server.registerTool("update_list", {
      title: "Update List",
      description: "Update a list name, archive state, subscription state, or board. Use update_list_position for moving a list within a board.",
      inputSchema: {
        listId: z.string().describe("ID of the Trello list to update"),
        name: z.string().optional().describe("New name for the list"),
        closed: z.boolean().optional().describe("Whether to close (archive) the list"),
        subscribed: z.boolean().optional().describe("Whether the authenticated user is subscribed to the list"),
        idBoard: z.string().optional().describe("ID of a board to move the list to")
      }
    }, async ({ listId, name, closed, subscribed, idBoard }) => {
      try {
        const params = {};
        if (name !== undefined)
          params.name = name;
        if (closed !== undefined)
          params.closed = closed;
        if (subscribed !== undefined)
          params.subscribed = subscribed;
        if (idBoard !== undefined)
          params.idBoard = idBoard;
        if (Object.keys(params).length === 0) {
          throw new McpError4(ErrorCode4.InvalidParams, "At least one of name, closed, subscribed, or idBoard must be provided");
        }
        const list = await this.trelloClient.updateList(listId, params);
        return {
          content: [{ type: "text", text: JSON.stringify(list, null, 2) }]
        };
      } catch (error) {
        return this.handleError(error);
      }
    });
    this.server.registerTool("update_list_position", {
      title: "Update List Position",
      description: 'Update the position of a list on the board. Trello uses fractional indexing: each list has a float position, and to place a list between two others, use the average of their positions (e.g., between pos 1024 and 2048, use 1536). Use "top"/"bottom" shortcuts to move to the edges.',
      inputSchema: {
        listId: z.string().describe("ID of the list to reposition"),
        position: z.string().refine((val) => {
          if (val === "top" || val === "bottom")
            return true;
          const num = Number(val);
          return num > 0 && isFinite(num);
        }, {
          message: "Position must be 'top', 'bottom', or a positive finite numeric string."
        }).describe('New position: "top" (move to leftmost), "bottom" (move to rightmost), or a numeric string (e.g. "1536"). To place between two lists, use the average of their pos values.')
      }
    }, async ({ listId, position }) => {
      try {
        const parsedPosition = position === "top" || position === "bottom" ? position : Number(position);
        const list = await this.trelloClient.updateListPosition(listId, parsedPosition);
        return {
          content: [{ type: "text", text: JSON.stringify(list, null, 2) }]
        };
      } catch (error) {
        return this.handleError(error);
      }
    });
    this.server.registerTool("get_my_cards", {
      title: "Get My Cards",
      description: "Fetch all cards assigned to the current user",
      inputSchema: {}
    }, async () => {
      try {
        const cards = await this.trelloClient.getMyCards();
        return {
          content: [{ type: "text", text: JSON.stringify(cards, null, 2) }]
        };
      } catch (error) {
        return this.handleError(error);
      }
    });
    this.server.registerTool("attach_image_to_card", {
      title: "Attach Image to Card",
      description: "Attach an image to a card from a URL on a specific board",
      inputSchema: {
        boardId: z.string().optional().describe("ID of the Trello board where the card exists (uses default if not provided)"),
        cardId: z.string().describe("ID of the card to attach the image to"),
        imageUrl: z.string().describe("URL of the image to attach"),
        name: z.string().optional().default("Image Attachment").describe('Optional name for the attachment (defaults to "Image Attachment")')
      }
    }, async ({ boardId, cardId, imageUrl, name }) => {
      try {
        const attachment = await this.trelloClient.attachImageToCard(boardId, cardId, imageUrl, name);
        return {
          content: [{ type: "text", text: JSON.stringify(attachment, null, 2) }]
        };
      } catch (error) {
        return this.handleError(error);
      }
    });
    this.server.registerTool("attach_file_to_card", {
      title: "Attach File to Card",
      description: "Attach any file to a card from a URL on a specific board",
      inputSchema: {
        boardId: z.string().optional().describe("ID of the Trello board where the card exists (uses default if not provided)"),
        cardId: z.string().describe("ID of the card to attach the file to"),
        fileUrl: z.string().describe("URL of the file to attach"),
        name: z.string().optional().default("File Attachment").describe('Optional name for the attachment (defaults to "File Attachment")'),
        mimeType: z.string().optional().describe('Optional MIME type of the file (e.g., "application/pdf", "text/plain", "video/mp4")')
      }
    }, async ({ boardId, cardId, fileUrl, name, mimeType }) => {
      try {
        const attachment = await this.trelloClient.attachFileToCard(boardId, cardId, fileUrl, name, mimeType);
        return {
          content: [{ type: "text", text: JSON.stringify(attachment, null, 2) }]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${error instanceof Error ? error.message : "Unknown error occurred"}`
            }
          ],
          isError: true
        };
      }
    });
    this.server.registerTool("attach_data_to_card", {
      title: "Attach Data to Card",
      description: "Attach binary data (image, markdown, PDF, text, etc.) to a card from base64-encoded data or a data URL. Use this for any non-image content. For image/screenshot uploads with PNG defaults, see attach_image_data_to_card.",
      inputSchema: {
        boardId: z.string().optional().describe("ID of the Trello board where the card exists (uses default if not provided)"),
        cardId: z.string().describe("ID of the card to attach the data to"),
        data: z.string().describe("Base64-encoded data or a data URL (e.g. data:text/markdown;base64,...). Any content type, not just images."),
        name: z.string().optional().describe('Filename for the attachment, including extension (e.g. "notes.md", "report.pdf"). Defaults to "attachment-<timestamp>".'),
        mimeType: z.string().optional().describe('MIME type of the data (e.g. "text/markdown", "application/pdf", "image/png"). Recommended for correct rendering in Trello. If omitted, inferred from a data URL prefix or the filename extension; falls back to "application/octet-stream".')
      }
    }, async ({ boardId, cardId, data, name, mimeType }) => {
      try {
        const attachment = await this.trelloClient.attachDataToCard(boardId, cardId, data, name, mimeType);
        return {
          content: [{ type: "text", text: JSON.stringify(attachment, null, 2) }]
        };
      } catch (error) {
        return this.handleError(error);
      }
    });
    this.server.registerTool("attach_image_data_to_card", {
      title: "Attach Image Data to Card",
      description: "Attach an image to a card from base64 data or a data URL. Image-flavored convenience over attach_data_to_card: defaults assume PNG when mimeType/name are omitted, suitable for screenshot pasting. For non-image content, use attach_data_to_card.",
      inputSchema: {
        boardId: z.string().optional().describe("ID of the Trello board where the card exists (uses default if not provided)"),
        cardId: z.string().describe("ID of the card to attach the image to"),
        imageData: z.string().describe("Base64 encoded image data or data URL (e.g., data:image/png;base64,...)"),
        name: z.string().optional().describe("Optional name for the attachment"),
        mimeType: z.string().optional().default("image/png").describe("Optional MIME type (default: image/png)")
      }
    }, async ({ boardId, cardId, imageData, name, mimeType }) => {
      try {
        const attachment = await this.trelloClient.attachImageDataToCard(boardId, cardId, imageData, name, mimeType);
        return {
          content: [{ type: "text", text: JSON.stringify(attachment, null, 2) }]
        };
      } catch (error) {
        return this.handleError(error);
      }
    });
    this.server.registerTool("list_boards", {
      title: "List Boards",
      description: "List all boards the user has access to",
      inputSchema: {}
    }, async () => {
      try {
        const boards = await this.trelloClient.listBoards();
        return {
          content: [{ type: "text", text: JSON.stringify(boards, null, 2) }]
        };
      } catch (error) {
        return this.handleError(error);
      }
    });
    this.server.registerTool("set_active_board", {
      title: "Set Active Board",
      description: "Set the active board for future operations",
      inputSchema: {
        boardId: z.string().describe("ID of the board to set as active")
      }
    }, async ({ boardId }) => {
      try {
        const board = await this.trelloClient.setActiveBoard(boardId);
        return {
          content: [
            {
              type: "text",
              text: `Successfully set active board to "${board.name}" (${board.id})`
            }
          ]
        };
      } catch (error) {
        return this.handleError(error);
      }
    });
    this.server.registerTool("list_workspaces", {
      title: "List Workspaces",
      description: "List workspaces the user has access to. If TRELLO_ALLOWED_WORKSPACES is configured, only allowed workspaces are returned.",
      inputSchema: {}
    }, async () => {
      try {
        const workspaces = await this.trelloClient.listWorkspaces();
        return {
          content: [{ type: "text", text: JSON.stringify(workspaces, null, 2) }]
        };
      } catch (error) {
        return this.handleError(error);
      }
    });
    this.server.registerTool("create_board", {
      title: "Create Board",
      description: "Create a new Trello board optionally within a workspace",
      inputSchema: {
        name: z.string().describe("Name of the board"),
        desc: z.string().optional().describe("Description of the board"),
        idOrganization: z.string().min(1).optional().describe("Workspace ID to create the board in (uses active if not provided)"),
        defaultLabels: z.boolean().optional().default(true).describe("Create default labels (true by default)"),
        defaultLists: z.boolean().optional().default(true).describe("Create default lists (true by default)")
      }
    }, async ({ name, desc, idOrganization, defaultLabels, defaultLists }) => {
      try {
        const board = await this.trelloClient.createBoard({
          name,
          desc,
          idOrganization,
          defaultLabels,
          defaultLists
        });
        return {
          content: [{ type: "text", text: JSON.stringify(board, null, 2) }]
        };
      } catch (error) {
        return this.handleError(error);
      }
    });
    this.server.registerTool("set_active_workspace", {
      title: "Set Active Workspace",
      description: "Set the active workspace for future operations",
      inputSchema: {
        workspaceId: z.string().describe("ID of the workspace to set as active")
      }
    }, async ({ workspaceId }) => {
      try {
        const workspace = await this.trelloClient.setActiveWorkspace(workspaceId);
        return {
          content: [
            {
              type: "text",
              text: `Successfully set active workspace to "${workspace.displayName}" (${workspace.id})`
            }
          ]
        };
      } catch (error) {
        return this.handleError(error);
      }
    });
    this.server.registerTool("list_boards_in_workspace", {
      title: "List Boards in Workspace",
      description: "List all boards in a specific workspace",
      inputSchema: {
        workspaceId: z.string().describe("ID of the workspace to list boards from")
      }
    }, async ({ workspaceId }) => {
      try {
        const boards = await this.trelloClient.listBoardsInWorkspace(workspaceId);
        return {
          content: [{ type: "text", text: JSON.stringify(boards, null, 2) }]
        };
      } catch (error) {
        return this.handleError(error);
      }
    });
    this.server.registerTool("get_active_board_info", {
      title: "Get Active Board Info",
      description: "Get information about the currently active board",
      inputSchema: {}
    }, async () => {
      try {
        const boardId = this.trelloClient.activeBoardId;
        if (!boardId) {
          return {
            content: [{ type: "text", text: "No active board set" }],
            isError: true
          };
        }
        const board = await this.trelloClient.getBoardById(boardId);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ...board,
                isActive: true,
                activeWorkspaceId: this.trelloClient.activeWorkspaceId || "Not set"
              }, null, 2)
            }
          ]
        };
      } catch (error) {
        return this.handleError(error);
      }
    });
    this.server.registerTool("get_card", {
      title: "Get Card",
      description: "Get detailed information about a specific Trello card",
      inputSchema: {
        cardId: z.string().describe("ID of the card to fetch"),
        includeMarkdown: z.boolean().optional().default(false).describe("Whether to return card description in markdown format (default: false)")
      }
    }, async ({ cardId, includeMarkdown }) => {
      try {
        const card = await this.trelloClient.getCard(cardId, includeMarkdown);
        return {
          content: [{ type: "text", text: JSON.stringify(card, null, 2) }]
        };
      } catch (error) {
        return this.handleError(error);
      }
    });
    this.server.registerTool("add_comment", {
      title: "Add Comment to Card",
      description: "Add the given text as a new comment to the given card",
      inputSchema: {
        cardId: z.string().describe("ID of the card to comment on"),
        text: z.string().describe("The text of the comment to add")
      }
    }, async ({ cardId, text }) => {
      try {
        const comment = await this.trelloClient.addCommentToCard(cardId, text);
        return {
          content: [{ type: "text", text: JSON.stringify(comment, null, 2) }]
        };
      } catch (error) {
        return this.handleError(error);
      }
    });
    this.server.registerTool("update_comment", {
      title: "Update Comment on Card",
      description: "Update the given comment with the new text",
      inputSchema: {
        commentId: z.string().describe("ID of the comment to change"),
        text: z.string().describe("The new text of the comment")
      }
    }, async ({ commentId, text }) => {
      try {
        const success = await this.trelloClient.updateCommentOnCard(commentId, text);
        return {
          content: [{ type: "text", text: success ? "success" : "failure" }]
        };
      } catch (error) {
        return this.handleError(error);
      }
    });
    this.server.registerTool("delete_comment", {
      title: "Delete Comment from Card",
      description: "Delete a comment from a Trello card",
      inputSchema: {
        commentId: z.string().describe("ID of the comment to delete")
      }
    }, async ({ commentId }) => {
      try {
        const success = await this.trelloClient.deleteCommentFromCard(commentId);
        return {
          content: [{ type: "text", text: success ? "success" : "failure" }]
        };
      } catch (error) {
        return this.handleError(error);
      }
    });
    this.server.registerTool("get_card_comments", {
      title: "Get Card Comments",
      description: "Retrieve all comments from a specific Trello card",
      inputSchema: {
        cardId: z.string().describe("ID of the card to get comments from"),
        limit: z.number().optional().default(100).describe("Maximum number of comments to retrieve (default: 100)")
      }
    }, async ({ cardId, limit }) => {
      try {
        const comments = await this.trelloClient.getCardComments(cardId, limit);
        return {
          content: [{ type: "text", text: JSON.stringify(comments, null, 2) }]
        };
      } catch (error) {
        return this.handleError(error);
      }
    });
    this.server.registerTool("create_checklist", {
      title: "Create Checklist",
      description: "Create a new checklist",
      inputSchema: {
        name: z.string().describe("Name of the checklist to create"),
        cardId: z.string().describe("ID of the Trello card")
      }
    }, async ({ name, cardId }) => {
      try {
        const items = await this.trelloClient.createChecklist(name, cardId);
        return {
          content: [{ type: "text", text: JSON.stringify(items, null, 2) }]
        };
      } catch (error) {
        return this.handleError(error);
      }
    });
    this.server.registerTool("get_checklist_items", {
      title: "Get Checklist Items",
      description: "Get all items from a checklist by name",
      inputSchema: {
        name: z.string().describe("Name of the checklist to retrieve items from"),
        cardId: z.string().optional().describe("ID of the card to scope checklist search to (recommended to avoid ambiguity)"),
        boardId: z.string().optional().describe("ID of the Trello board (uses default if not provided)")
      }
    }, async ({ name, cardId, boardId }) => {
      try {
        const items = await this.trelloClient.getChecklistItems(name, cardId, boardId);
        return {
          content: [{ type: "text", text: JSON.stringify(items, null, 2) }]
        };
      } catch (error) {
        return this.handleError(error);
      }
    });
    this.server.registerTool("add_checklist_item", {
      title: "Add Checklist Item",
      description: "Add a new item to a checklist",
      inputSchema: {
        text: z.string().describe("Text content of the checklist item"),
        checkListName: z.string().describe("Name of the checklist to add the item to"),
        cardId: z.string().optional().describe("ID of the card to scope checklist search to (recommended to avoid ambiguity)"),
        boardId: z.string().optional().describe("ID of the Trello board (uses default if not provided)")
      }
    }, async ({ text, checkListName, cardId, boardId }) => {
      try {
        const item = await this.trelloClient.addChecklistItem(text, checkListName, cardId, boardId);
        return {
          content: [{ type: "text", text: JSON.stringify(item, null, 2) }]
        };
      } catch (error) {
        return this.handleError(error);
      }
    });
    this.server.registerTool("find_checklist_items_by_description", {
      title: "Find Checklist Items by Description",
      description: "Search for checklist items containing specific text in their description",
      inputSchema: {
        description: z.string().describe("Text to search for in checklist item descriptions"),
        cardId: z.string().optional().describe("ID of the card to scope checklist search to (recommended to avoid ambiguity)"),
        boardId: z.string().optional().describe("ID of the Trello board (uses default if not provided)")
      }
    }, async ({ description, cardId, boardId }) => {
      try {
        const items = await this.trelloClient.findChecklistItemsByDescription(description, cardId, boardId);
        return {
          content: [{ type: "text", text: JSON.stringify(items, null, 2) }]
        };
      } catch (error) {
        return this.handleError(error);
      }
    });
    this.server.registerTool("get_acceptance_criteria", {
      title: "Get Acceptance Criteria",
      description: 'Get all items from the "Acceptance Criteria" checklist',
      inputSchema: {
        cardId: z.string().optional().describe("ID of the card to scope checklist search to (recommended to avoid ambiguity)"),
        boardId: z.string().optional().describe("ID of the Trello board (uses default if not provided)")
      }
    }, async ({ cardId, boardId }) => {
      try {
        const items = await this.trelloClient.getAcceptanceCriteria(cardId, boardId);
        return {
          content: [{ type: "text", text: JSON.stringify(items, null, 2) }]
        };
      } catch (error) {
        return this.handleError(error);
      }
    });
    this.server.registerTool("get_checklist_by_name", {
      title: "Get Checklist by Name",
      description: "Get a complete checklist with all its items and completion percentage",
      inputSchema: {
        name: z.string().describe("Name of the checklist to retrieve"),
        cardId: z.string().optional().describe("ID of the card to scope checklist search to (recommended to avoid ambiguity)"),
        boardId: z.string().optional().describe("ID of the Trello board (uses default if not provided)")
      }
    }, async ({ name, cardId, boardId }) => {
      try {
        const checklist = await this.trelloClient.getChecklistByName(name, cardId, boardId);
        if (!checklist) {
          return {
            content: [{ type: "text", text: `Checklist "${name}" not found` }],
            isError: true
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify(checklist, null, 2) }]
        };
      } catch (error) {
        return this.handleError(error);
      }
    });
    this.server.registerTool("update_checklist_item", {
      title: "Update Checklist Item",
      description: "Update a checklist item name, state, position, due date, reminder, or assigned member",
      inputSchema: {
        cardId: z.string().describe("ID of the card containing the checklist item"),
        checkItemId: z.string().describe("ID of the checklist item to update"),
        state: z.enum(["complete", "incomplete"]).optional().describe("New state for the checklist item"),
        name: z.string().optional().describe("New text for the checklist item"),
        pos: z.union([z.number(), z.enum(["top", "bottom"])]).optional().describe("New position for the checklist item"),
        due: z.string().nullable().optional().describe("New due date for the checklist item in ISO 8601 format, or null to clear it"),
        dueReminder: z.number().nullable().optional().describe("Reminder offset in minutes before due date, or null to clear it"),
        idMember: z.string().nullable().optional().describe("Member ID to assign to the checklist item, or null to clear it")
      }
    }, async ({ cardId, checkItemId, name, state, pos, due, dueReminder, idMember }) => {
      try {
        const item = await this.trelloClient.updateChecklistItem(cardId, checkItemId, {
          name,
          state,
          pos,
          due,
          dueReminder,
          idMember
        });
        return {
          content: [{ type: "text", text: JSON.stringify(item, null, 2) }]
        };
      } catch (error) {
        return this.handleError(error);
      }
    });
    this.server.registerTool("delete_checklist_item", {
      title: "Delete Checklist Item",
      description: "Delete a checklist item from a card",
      inputSchema: {
        cardId: z.string().describe("ID of the card containing the checklist item"),
        checkItemId: z.string().describe("ID of the checklist item to delete")
      }
    }, async ({ cardId, checkItemId }) => {
      try {
        const deleted = await this.trelloClient.deleteChecklistItem(cardId, checkItemId);
        return {
          content: [{ type: "text", text: JSON.stringify({ deleted }, null, 2) }]
        };
      } catch (error) {
        return this.handleError(error);
      }
    });
    this.server.registerTool("get_board_members", {
      title: "Get Board Members",
      description: "Get all members of a specific board",
      inputSchema: {
        boardId: z.string().optional().describe("ID of the Trello board (uses default if not provided)")
      }
    }, async ({ boardId }) => {
      try {
        const members = await this.trelloClient.getBoardMembers(boardId);
        return {
          content: [{ type: "text", text: JSON.stringify(members, null, 2) }]
        };
      } catch (error) {
        return this.handleError(error);
      }
    });
    this.server.registerTool("assign_member_to_card", {
      title: "Assign Member to Card",
      description: "Assign a member to a specific card",
      inputSchema: {
        cardId: z.string().describe("ID of the card to assign the member to"),
        memberId: z.string().describe("ID of the member to assign to the card")
      }
    }, async ({ cardId, memberId }) => {
      try {
        const card = await this.trelloClient.assignMemberToCard(cardId, memberId);
        return {
          content: [{ type: "text", text: JSON.stringify(card, null, 2) }]
        };
      } catch (error) {
        return this.handleError(error);
      }
    });
    this.server.registerTool("remove_member_from_card", {
      title: "Remove Member from Card",
      description: "Remove a member from a specific card",
      inputSchema: {
        cardId: z.string().describe("ID of the card to remove the member from"),
        memberId: z.string().describe("ID of the member to remove from the card")
      }
    }, async ({ cardId, memberId }) => {
      try {
        const card = await this.trelloClient.removeMemberFromCard(cardId, memberId);
        return {
          content: [{ type: "text", text: JSON.stringify(card, null, 2) }]
        };
      } catch (error) {
        return this.handleError(error);
      }
    });
    this.server.registerTool("get_board_labels", {
      title: "Get Board Labels",
      description: "Get all labels of a specific board",
      inputSchema: {
        boardId: z.string().optional().describe("ID of the Trello board (uses default if not provided)")
      }
    }, async ({ boardId }) => {
      try {
        const labels = await this.trelloClient.getBoardLabels(boardId);
        return {
          content: [{ type: "text", text: JSON.stringify(labels, null, 2) }]
        };
      } catch (error) {
        return this.handleError(error);
      }
    });
    this.server.registerTool("create_label", {
      title: "Create Label",
      description: "Create a new label on a board",
      inputSchema: {
        boardId: z.string().optional().describe("ID of the Trello board (uses default if not provided)"),
        name: z.string().describe("Name of the label"),
        color: z.string().optional().describe('Color of the label (e.g., "red", "blue", "green", "yellow", "orange", "purple", "pink", "sky", "lime", "black", "null")')
      }
    }, async ({ boardId, name, color }) => {
      try {
        const label = await this.trelloClient.createLabel(boardId, name, color);
        return {
          content: [{ type: "text", text: JSON.stringify(label, null, 2) }]
        };
      } catch (error) {
        return this.handleError(error);
      }
    });
    this.server.registerTool("update_label", {
      title: "Update Label",
      description: "Update an existing label",
      inputSchema: {
        labelId: z.string().describe("ID of the label to update"),
        name: z.string().optional().describe("New name for the label"),
        color: z.string().optional().describe("New color for the label")
      }
    }, async ({ labelId, name, color }) => {
      try {
        const label = await this.trelloClient.updateLabel(labelId, name, color);
        return {
          content: [{ type: "text", text: JSON.stringify(label, null, 2) }]
        };
      } catch (error) {
        return this.handleError(error);
      }
    });
    this.server.registerTool("delete_label", {
      title: "Delete Label",
      description: "Delete a label from a board",
      inputSchema: {
        labelId: z.string().describe("ID of the label to delete")
      }
    }, async ({ labelId }) => {
      try {
        await this.trelloClient.deleteLabel(labelId);
        return {
          content: [{ type: "text", text: "Label deleted successfully" }]
        };
      } catch (error) {
        return this.handleError(error);
      }
    });
    this.server.registerTool("copy_card", {
      title: "Copy Card",
      description: "Copy/duplicate a Trello card to any list (even on a different board). Copies all properties by default including checklists, attachments, comments, labels, etc.",
      inputSchema: {
        sourceCardId: z.string().describe("ID of the source card to copy"),
        listId: z.string().describe("ID of the destination list (can be on a different board)"),
        name: z.string().optional().describe("Override the name of the copied card (defaults to source card name)"),
        description: z.string().optional().describe("Override the description of the copied card"),
        keepFromSource: z.string().optional().describe('Comma-separated list of properties to copy: "all" (default), or any combination of: attachments, checklists, comments, customFields, due, start, labels, members, stickers'),
        pos: z.string().optional().describe('Position of the new card: "top", "bottom", or a positive float')
      }
    }, async ({ sourceCardId, listId, name, description, keepFromSource, pos }) => {
      try {
        const card = await this.trelloClient.copyCard({
          sourceCardId,
          listId,
          name,
          description,
          keepFromSource,
          pos
        });
        return {
          content: [{ type: "text", text: JSON.stringify(card, null, 2) }]
        };
      } catch (error) {
        return this.handleError(error);
      }
    });
    this.server.registerTool("copy_checklist", {
      title: "Copy Checklist",
      description: "Copy a checklist (with all its items) from one card to another. Works across different boards.",
      inputSchema: {
        sourceChecklistId: z.string().describe("ID of the source checklist to copy"),
        cardId: z.string().describe("ID of the destination card to copy the checklist to"),
        name: z.string().optional().describe("Override the name of the copied checklist (defaults to source checklist name)"),
        pos: z.string().optional().describe('Position of the new checklist: "top", "bottom", or a positive number')
      }
    }, async ({ sourceChecklistId, cardId, name, pos }) => {
      try {
        const checklist = await this.trelloClient.copyChecklist({
          sourceChecklistId,
          cardId,
          name,
          pos
        });
        return {
          content: [{ type: "text", text: JSON.stringify(checklist, null, 2) }]
        };
      } catch (error) {
        return this.handleError(error);
      }
    });
    this.server.registerTool("add_cards_to_list", {
      title: "Add Cards to List",
      description: "Add multiple cards to a list in one operation. Cards are created sequentially (Trello API does not support batch writes). Rate limiting is handled automatically.",
      inputSchema: {
        listId: z.string().describe("ID of the list to add cards to"),
        cards: z.array(z.object({
          name: z.string().describe("Name of the card"),
          description: z.string().optional().describe("Description of the card"),
          dueDate: z.string().optional().describe("Due date for the card (ISO 8601 format)"),
          start: z.string().optional().describe("Start date for the card (YYYY-MM-DD format)"),
          labels: z.array(z.string()).optional().describe("Array of label IDs to apply to the card")
        })).describe("Array of cards to create (max 50)")
      }
    }, async ({ listId, cards }) => {
      try {
        const results = await this.trelloClient.batchAddCards(listId, cards);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(results, null, 2)
            }
          ]
        };
      } catch (error) {
        return this.handleError(error);
      }
    });
    this.server.registerTool("get_board_custom_fields", {
      title: "Get Board Custom Fields",
      description: "Get all custom field definitions on a board. Returns field IDs, names, and types. " + "For dropdown/list fields, also returns available options with their IDs. " + "Requires Trello Standard plan or higher.",
      inputSchema: {
        boardId: z.string().optional().describe("ID of the Trello board (uses default if not provided)")
      }
    }, async ({ boardId }) => {
      try {
        const fields = await this.trelloClient.getBoardCustomFields(boardId);
        const fieldsWithOptions = await Promise.all(fields.map(async (field) => {
          if (field.type !== "list") {
            return field;
          }
          try {
            const options = await this.trelloClient.getCustomFieldOptions(field.id);
            return { ...field, options };
          } catch (error) {
            return {
              ...field,
              optionsError: error instanceof Error ? error.message : "Failed to fetch options"
            };
          }
        }));
        return {
          content: [
            { type: "text", text: JSON.stringify(fieldsWithOptions, null, 2) }
          ]
        };
      } catch (error) {
        return this.handleError(error);
      }
    });
    this.server.registerTool("update_card_custom_field", {
      title: "Update Card Custom Field",
      description: "Set or clear a custom field value on a card. Requires Trello Standard plan or higher. " + "Use get_board_custom_fields first to find field IDs and types. " + "Value format depends on type: text=any string, number=numeric string, " + 'checkbox="true"/"false", date=ISO 8601 string, list=option ID from get_board_custom_fields. ' + 'To clear a field, set type to "clear" and omit value.',
      inputSchema: {
        cardId: z.string().describe("ID of the card to update"),
        customFieldId: z.string().describe("ID of the custom field definition"),
        type: z.enum(["text", "number", "checkbox", "date", "list", "clear"]).describe('The custom field type. Use "clear" to remove the value from the field.'),
        value: z.string().optional().describe('The value to set. For text: any string. For number: numeric string (e.g. "42.5"). ' + 'For checkbox: "true" or "false". For date: ISO 8601 (e.g. "2025-12-31T00:00:00.000Z"). ' + 'For list: the option ID. Not needed when type is "clear".')
      }
    }, async ({ cardId, customFieldId, type, value }) => {
      try {
        if (type !== "clear" && !value) {
          return {
            content: [
              {
                type: "text",
                text: 'Error: value is required when type is not "clear"'
              }
            ],
            isError: true
          };
        }
        const result = await this.trelloClient.updateCardCustomField(cardId, customFieldId, {
          type,
          value
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
        };
      } catch (error) {
        return this.handleError(error);
      }
    });
    this.server.registerTool("get_card_history", {
      title: "Get Card History",
      description: "Get the history/actions of a specific card",
      inputSchema: {
        cardId: z.string().describe("ID of the card to get history for"),
        filter: z.string().optional().describe('Optional: Filter actions by type (e.g., "all", "updateCard:idList", "addAttachmentToCard", "commentCard", "updateCard:name", "updateCard:desc", "updateCard:due", "addMemberToCard", "removeMemberFromCard", "addLabelToCard", "removeLabelFromCard")'),
        limit: z.number().optional().describe("Optional: Number of actions to fetch (default: all)")
      }
    }, async ({ cardId, filter, limit }) => {
      try {
        const history = await this.trelloClient.getCardHistory(cardId, filter, limit);
        return {
          content: [{ type: "text", text: JSON.stringify(history, null, 2) }]
        };
      } catch (error) {
        return this.handleError(error);
      }
    });
    this.server.registerTool("download_attachment", {
      title: "Download Attachment",
      description: "Download an attachment from a card. Returns base64-encoded data that can be saved or viewed.",
      inputSchema: {
        cardId: z.string().describe("ID of the card containing the attachment"),
        attachmentId: z.string().describe("ID of the attachment to download")
      }
    }, async ({ cardId, attachmentId }) => {
      try {
        const result = await this.trelloClient.downloadAttachment(cardId, attachmentId);
        if (result.mimeType.startsWith("image/")) {
          return {
            content: [
              {
                type: "image",
                data: result.data,
                mimeType: result.mimeType
              },
              {
                type: "text",
                text: `Downloaded: ${result.fileName} (${result.mimeType})`
              }
            ]
          };
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ fileName: result.fileName, mimeType: result.mimeType, data: result.data }, null, 2)
            }
          ]
        };
      } catch (error) {
        return this.handleError(error);
      }
    });
  }
  setupHealthEndpoints() {
    this.server.registerTool("get_health", HealthEndpointSchemas.basicHealth, async () => {
      try {
        return await this.healthEndpoints.getBasicHealth();
      } catch (error) {
        return this.handleError(error);
      }
    });
    this.server.registerTool("get_health_detailed", HealthEndpointSchemas.detailedHealth, async () => {
      try {
        return await this.healthEndpoints.getDetailedHealth();
      } catch (error) {
        return this.handleError(error);
      }
    });
    this.server.registerTool("get_health_metadata", HealthEndpointSchemas.metadataHealth, async () => {
      try {
        return await this.healthEndpoints.getMetadataHealth();
      } catch (error) {
        return this.handleError(error);
      }
    });
    this.server.registerTool("get_health_performance", HealthEndpointSchemas.performanceHealth, async () => {
      try {
        return await this.healthEndpoints.getPerformanceHealth();
      } catch (error) {
        return this.handleError(error);
      }
    });
    this.server.registerTool("perform_system_repair", HealthEndpointSchemas.repair, async () => {
      try {
        return await this.healthEndpoints.performRepair();
      } catch (error) {
        return this.handleError(error);
      }
    });
  }
  async run() {
    const transport = new StdioServerTransport;
    await this.trelloClient.loadConfig().catch(() => {});
    await this.server.connect(transport);
  }
}
var server = new TrelloServer;
server.run().catch(() => {});
