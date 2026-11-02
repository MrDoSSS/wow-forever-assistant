-- Game-log-style chat: saved conversations, messages and settings.
-- Labels use Latin letters for enUS fonts; preserve player text without translation.
local _, FA = ...
local UI, Core = FA.UI, FA.Core
local T = UI.Theme
local frame, log, input, status, chatView, sidebar, title, subtitle, empty
local rows, chatOffset = {}, 0
local send, newChat, deleteChat, resize
local renderedConversation, renderedLines
local scrollbar, measurer, syncing, renderPending
local wrapCache, wrapKey = {}, nil

-- Wheel: two lines per notch; Shift scrolls a page.
local WHEEL_LINES = 2
local LINE_SPACING = 6

BINDING_HEADER_FOREVERASSISTANT = "WoW Forever Assistant"
BINDING_NAME_FOREVERASSISTANT_TOGGLE = "Toggle assistant chat"

function UI.requestReload()
  if type(ReloadUI) == "function" and pcall(ReloadUI) then return true end
  UI.setStatus("Could not reload the UI. Type /reload in game chat.")
  Core.print(UI.lastStatus)
  return false
end

function UI.setSlotsRemaining(left)
  UI.slotsRemaining = left <= FA.Inbound.LOW_SLOT_THRESHOLD and left or nil
  if not UI.reloadButton then return end
  if UI.slotsRemaining then
    UI.reloadButton:Show(); UI.slotsLabel:Show()
    UI.slotsLabel:SetText(left == 0 and "Reload needed" or string.format("%d slots left", left))
    if left == 0 then UI.slotsLabel:SetTextColor(1, 0.4, 0.3)
    else UI.slotsLabel:SetTextColor(0.94, 0.76, 0.42) end
  else
    UI.reloadButton:Hide(); UI.slotsLabel:Hide()
  end
end

-- The dialog is available before the assistant window is first opened.
StaticPopupDialogs.FOREVERASSISTANT_RELOAD_SLOTS = {
  text = "%s\n\nYour chats, drafts and pending question are kept.",
  button1 = "Reload UI", button2 = "Later",
  OnAccept = function() UI.requestReload() end,
  timeout = 0, whileDead = true, hideOnEscape = true,
}

function UI.notifySlots(left)
  UI.setSlotsRemaining(left)
  local message = left == 0 and "Assistant exchange slots are used up. Reload the UI to continue."
    or string.format("Only %d assistant exchange slots remain. Reload the UI to restore them.", left)
  if StaticPopup_Hide then StaticPopup_Hide("FOREVERASSISTANT_RELOAD_SLOTS") end
  StaticPopup_Show("FOREVERASSISTANT_RELOAD_SLOTS", message)
end

local function saveLayout()
  local prefs = UI.preferences()
  local point, _, relativePoint, x, y = frame:GetPoint(1)
  prefs.point, prefs.relativePoint, prefs.x, prefs.y = point, relativePoint, x, y
  prefs.width, prefs.height = frame:GetWidth(), frame:GetHeight()
end

function UI.applyAppearance()
  if not frame then return end
  local prefs = UI.preferences()
  local fit = math.min(1.25, (UIParent:GetHeight() - 28) / prefs.height, (UIParent:GetWidth() - 28) / prefs.width)
  frame:SetScale(math.max(0.5, math.min(prefs.scale, fit)))
  frame:SetSize(prefs.width, prefs.height)
  if frame.SetBackdropColor then frame:SetBackdropColor(0.045, 0.042, 0.038, prefs.opacity) end
  local logFontReady = T.setContentFont(log, prefs.fontSize)
  T.setContentFont(measurer, prefs.fontSize)
  local inputFontReady = T.setContentFont(input, prefs.fontSize)
  if not logFontReady or not inputFontReady then
    UI.setStatus("Chat font could not load. Fully restart WoW to load the new font file.")
  end
  log:SetSpacing(LINE_SPACING)
  frame:SetMovable(not prefs.locked)
  frame:SetResizable(not prefs.locked)
  if prefs.locked then resize:Hide() else resize:Show() end
end

local function failure(reason)
  if reason == "busy" then
    UI.setStatus("Wait for the answer or press Stop before switching conversations.")
  elseif reason == "queue_full" then
    UI.setStatus("The send queue is full. Wait for the bridge, then try again.")
  else UI.setStatus("The conversation could not be opened: " .. tostring(reason)) end
end

local function selectChat(id)
  local ok, reason = FA.Assistant.selectChat(id)
  if ok then UI.showSettings(false) else failure(reason) end
end

local function sendInput()
  local text = input:GetText()
  if not text:find("%S") then return end
  local key, reason = FA.Assistant.ask(text)
  if key then
    input:SetText(""); input:ClearFocus()
  elseif reason == "busy" then
    UI.setStatus("Still answering: wait or press Stop. Your draft is kept.")
  elseif reason == "too_large" then
    UI.setStatus("The question and context are too large. Disable some context in Settings.")
  elseif reason == "queue_full" then
    UI.setStatus("The send queue is full. Wait for the bridge; your draft is kept.")
  elseif reason == "clearing" then UI.setStatus("Clearing is waiting for the bridge.")
  elseif reason ~= "bad_text" then UI.setStatus("Not sent: " .. tostring(reason)) end
  UI.refreshActions()
end

local function composerAction()
  local state = FA.Assistant.state
  if state and state.active then FA.Assistant.stop() else sendInput() end
end

function UI.refreshActions()
  if not frame or not send then return end
  local state = FA.Assistant.state
  local ready = FA.Assistant.session.ready
  local busy = state and (state.active or state.pendingClear)
  local answering = state and state.active ~= nil
  send:SetText(answering and "Stop" or "Send")
  T.enabled(send, ready and (answering or (not busy and input:GetText():find("%S") ~= nil)))
  T.enabled(newChat, ready and not busy)
  T.enabled(deleteChat, ready and state and not state.pendingClear)
  subtitle:SetText(not ready and "Installation required" or (state.pendingClear and "Clearing conversation..." or (state.active and "Waiting for an answer..." or "Your companion in Azeroth")))
end

local function buildSidebar()
  sidebar = T.panel(frame, nil, 0.025, 0.026, 0.029)
  sidebar:SetPoint("TOPLEFT", 16, -76); sidebar:SetPoint("BOTTOMLEFT", 16, 18); sidebar:SetWidth(212)
  if sidebar.SetBackdropColor then sidebar:SetBackdropColor(0.025, 0.026, 0.029, 0.4) end
  local label = T.label(sidebar, "CONVERSATIONS", "GameFontNormalSmall", 0.71, 0.59, 0.37)
  label:SetPoint("TOPLEFT", 16, -17)
  newChat = T.button(sidebar, "+  New conversation", 184, function()
    local ok, reason = FA.Assistant.newChat()
    if ok then chatOffset = 0; UI.showSettings(false); UI.render() else failure(reason) end
  end, true)
  newChat:SetPoint("TOPLEFT", 14, -39)
  sidebar.list = CreateFrame("Frame", nil, sidebar)
  sidebar.list:SetPoint("TOPLEFT", 10, -80); sidebar.list:SetPoint("BOTTOMRIGHT", -10, 86)
  sidebar.list:EnableMouseWheel(true)
  sidebar.list:SetScript("OnMouseWheel", function(_, delta) chatOffset = math.max(0, chatOffset - delta); UI.refreshChats() end)
  sidebar.list:SetScript("OnSizeChanged", function() UI.refreshChats() end)
  sidebar.count = T.label(sidebar, "", "GameFontDisableSmall"); sidebar.count:SetPoint("BOTTOMLEFT", 16, 70)
  local options = T.button(sidebar, "Settings", 184, function() UI.showSettings(not UI.settings:IsShown()) end)
  options:SetPoint("BOTTOMLEFT", 14, 31)
  UI.shortcutHint = T.label(sidebar, "/fa", "GameFontDisableSmall"); UI.shortcutHint:SetPoint("BOTTOMLEFT", 16, 13)
  UI.shortcutHint:SetWidth(182); UI.shortcutHint:SetWordWrap(false)
  local previous = T.button(sidebar, "<", 26, function() chatOffset = math.max(0, chatOffset - 1); UI.refreshChats() end)
  previous:SetHeight(22); previous:SetPoint("BOTTOMRIGHT", -44, 65)
  local nextPage = T.button(sidebar, ">", 26, function() chatOffset = chatOffset + 1; UI.refreshChats() end)
  nextPage:SetHeight(22); nextPage:SetPoint("BOTTOMRIGHT", -14, 65)
  sidebar.previous, sidebar.nextPage = previous, nextPage
end

function UI.refreshChats()
  if not sidebar or not sidebar.list or not sidebar.previous then return end
  local chats = FA.Assistant.state and FA.Assistant.state.chats or {}
  local visible = math.max(1, math.floor(sidebar.list:GetHeight() / 52))
  chatOffset = math.max(0, math.min(chatOffset, math.max(0, #chats - visible)))
  for i = 1, visible do
    if not rows[i] then
      local row = CreateFrame("Button", nil, sidebar.list)
      row:SetHeight(48); row:SetPoint("TOPLEFT", 0, -(i - 1) * 52); row:SetPoint("TOPRIGHT", 0, -(i - 1) * 52)
      row.fill = T.texture(row, "BACKGROUND", 0.7, 0.48, 0.17, 0.14); row.fill:SetAllPoints()
      row.accent = T.texture(row, "ARTWORK", 0.84, 0.64, 0.3, 1)
      row.accent:SetWidth(2); row.accent:SetPoint("TOPLEFT"); row.accent:SetPoint("BOTTOMLEFT")
      row.title = T.label(row, "", "GameFontHighlightSmall")
      T.setContentFont(row.title, 12)
      row.title:SetPoint("TOPLEFT", 12, -9); row.title:SetPoint("TOPRIGHT", -10, -9); row.title:SetWordWrap(false)
      row.detail = T.label(row, "", "GameFontDisableSmall"); row.detail:SetPoint("BOTTOMLEFT", 12, 9)
      row:SetScript("OnClick", function(self) selectChat(self.chatId) end)
      row:SetScript("OnEnter", function(self) self.fill:SetAlpha(1) end)
      row:SetScript("OnLeave", function(self) self.fill:SetAlpha(self.selected and 1 or 0.15) end)
      rows[i] = row
    end
    local row, chat = rows[i], chats[i + chatOffset]
    if chat then
      row.chatId, row.selected = chat.id, chat.id == FA.Assistant.state.conversationId
      row.title:SetText(chat.title)
      row.detail:SetText(#chat.history == 0 and "A new adventure" or string.format("%d messages", #chat.history))
      row.fill:SetAlpha(row.selected and 1 or 0.15)
      if row.selected then row.accent:Show() else row.accent:Hide() end
      row:Show()
    else row:Hide() end
  end
  for i = visible + 1, #rows do rows[i]:Hide() end
  sidebar.count:SetText(string.format("%d saved", #chats))
  T.enabled(sidebar.previous, chatOffset > 0); T.enabled(sidebar.nextPage, chatOffset + visible < #chats)
end

function UI.showSettings(show)
  if not frame then UI.ensure() end
  if show then input:ClearFocus(); chatView:Hide(); UI.settings:Show(); UI.refreshSettings()
  else UI.settings:Hide(); chatView:Show(); UI.render() end
end

function UI.ensure()
  if frame then return frame end
  frame = T.panel(UIParent, "ForeverAssistantFrame", 0.045, 0.042, 0.038, 18); UI.frame = frame
  -- Normal window: above the HUD, with familiar click-to-front behavior.
  -- DIALOG blocked game windows, while LOW put chat below action bars.
  frame:SetFrameStrata("MEDIUM"); frame:SetToplevel(true)
  frame:SetClampedToScreen(true); frame:EnableMouse(true); frame:SetResizable(true)
  frame:SetScript("OnShow", function(self) self:Raise() end)
  if frame.SetResizeBounds then frame:SetResizeBounds(760, 660, 1200, 900)
  elseif frame.SetMinResize then frame:SetMinResize(760, 660); frame:SetMaxResize(1200, 900) end
  local prefs = UI.preferences()
  if prefs.point and type(prefs.x) == "number" and type(prefs.y) == "number" then
    frame:SetPoint(prefs.point, UIParent, prefs.relativePoint or prefs.point, prefs.x, prefs.y)
  else frame:SetPoint("CENTER") end
  tinsert(UISpecialFrames, "ForeverAssistantFrame")
  local header = CreateFrame("Frame", nil, frame)
  header:SetPoint("TOPLEFT", 8, -8); header:SetPoint("TOPRIGHT", -36, -8); header:SetHeight(58)
  header:EnableMouse(true); header:RegisterForDrag("LeftButton")
  header:SetScript("OnDragStart", function() if not UI.preferences().locked then frame:StartMoving() end end)
  header:SetScript("OnDragStop", function() frame:StopMovingOrSizing(); saveLayout() end)
  local icon = header:CreateTexture(nil, "ARTWORK")
  icon:SetSize(42, 42); icon:SetPoint("LEFT", 10, 0); icon:SetTexture("Interface\\Icons\\INV_Misc_Book_09"); icon:SetTexCoord(0.07, 0.93, 0.07, 0.93)
  local brand = T.label(header, "FOREVER ASSISTANT", "GameFontNormalLarge", 0.93, 0.77, 0.45); brand:SetPoint("TOPLEFT", 64, -10)
  subtitle = T.label(header, "Your companion in Azeroth", "GameFontDisableSmall"); subtitle:SetPoint("TOPLEFT", 65, -32)
  UI.reloadButton = T.button(header, "Reload UI", 84, function() UI.requestReload() end, true)
  UI.reloadButton:SetPoint("RIGHT", -12, 0)
  UI.slotsLabel = T.label(header, "", "GameFontNormalSmall")
  UI.slotsLabel:SetPoint("RIGHT", UI.reloadButton, "LEFT", -10, 0)
  UI.setSlotsRemaining(UI.slotsRemaining or FA.Inbound.slotsLeft())
  local close = CreateFrame("Button", nil, frame, "UIPanelCloseButton"); close:SetPoint("TOPRIGHT", -4, -4)
  T.rule(frame, -68); buildSidebar()
  local content = CreateFrame("Frame", nil, frame)
  content:SetPoint("TOPLEFT", 240, -76); content:SetPoint("BOTTOMRIGHT", -18, 18)
  chatView = CreateFrame("Frame", nil, content); chatView:SetAllPoints()
  title = T.label(chatView, "New conversation", "GameFontNormalLarge", 0.88, 0.76, 0.51)
  T.setContentFont(title, 16)
  title:SetPoint("TOPLEFT", 14, -14); title:SetPoint("TOPRIGHT", -186, -14); title:SetWordWrap(false)
  deleteChat = T.button(chatView, "Delete chat", 88, function()
    local state = FA.Assistant.state
    if state then StaticPopup_Show("FOREVERASSISTANT_DELETE", nil, nil, state.conversationId) end
  end)
  UI.deleteButton = deleteChat
  deleteChat:SetPoint("TOPRIGHT", -6, -6)
  UI.planButton = T.button(chatView, "Plan", 62, function() UI.togglePlan() end)
  UI.planButton:SetPoint("TOPRIGHT", -100, -6)
  T.rule(chatView, -44)
  log = CreateFrame("ScrollingMessageFrame", "ForeverAssistantLog", chatView)
  log:SetPoint("TOPLEFT", 18, -60); log:SetPoint("BOTTOMRIGHT", -18, 146)
  log:SetFontObject(GameFontHighlight); log:SetJustifyH("LEFT"); log:SetFading(false); log:SetMaxLines(1600); log:SetInsertMode("BOTTOM"); log:EnableMouseWheel(true)
  log:SetScript("OnMouseWheel", function(_, delta) UI.scrollLog(delta) end)
  -- Invisible text using the same font measures width for wrapping (UI/Wrap.lua).
  measurer = log:CreateFontString(nil, "OVERLAY"); measurer:Hide()
  -- Scrollbar value: 0 is the start of the conversation; maximum is the latest lines.
  scrollbar = CreateFrame("Slider", nil, chatView)
  scrollbar:SetOrientation("VERTICAL"); scrollbar:SetWidth(6)
  scrollbar:SetPoint("TOPRIGHT", chatView, "TOPRIGHT", -6, -60); scrollbar:SetPoint("BOTTOMRIGHT", chatView, "BOTTOMRIGHT", -6, 146)
  local track = scrollbar:CreateTexture(nil, "BACKGROUND"); track:SetAllPoints(); track:SetColorTexture(1, 1, 1, 0.06)
  local thumb = scrollbar:CreateTexture(nil, "OVERLAY"); thumb:SetColorTexture(0.88, 0.76, 0.51, 0.55); thumb:SetSize(6, 36)
  scrollbar:SetThumbTexture(thumb)
  scrollbar:SetValueStep(1)
  if scrollbar.SetObeyStepOnDrag then scrollbar:SetObeyStepOnDrag(true) end
  scrollbar:EnableMouseWheel(true)
  scrollbar:SetScript("OnMouseWheel", function(_, delta) UI.scrollLog(delta) end)
  scrollbar:SetScript("OnValueChanged", function(_, value)
    if syncing or not value then return end
    log:SetScrollOffset(math.max(0, math.floor(UI.maxScroll() - value + 0.5)))
  end)
  scrollbar:Hide()
  if log.SetOnScrollChangedCallback then log:SetOnScrollChangedCallback(function() UI.syncScroll() end) end
  log:SetHyperlinksEnabled(true)
  log:SetScript("OnHyperlinkEnter", function(self, link) FA.Items.onEnter(self, link) end)
  log:SetScript("OnHyperlinkLeave", function() FA.Items.onLeave() end)
  log:SetScript("OnHyperlinkClick", function(_, link, text, mouseButton) FA.Items.onClick(link, text, mouseButton, input) end)
  empty = CreateFrame("Frame", nil, chatView)
  empty:SetPoint("TOPLEFT", log, "TOPLEFT"); empty:SetPoint("BOTTOMRIGHT", log, "BOTTOMRIGHT")
  local emptyIcon = empty:CreateTexture(nil, "ARTWORK")
  emptyIcon:SetTexture("Interface\\Icons\\INV_Misc_Book_09"); emptyIcon:SetSize(56, 56); emptyIcon:SetPoint("CENTER", 0, 61); emptyIcon:SetAlpha(0.8)
  local welcome = T.label(empty, "What is your next adventure?", "GameFontNormalLarge", 0.90, 0.76, 0.49); welcome:SetPoint("CENTER", 0, 8)
  local description = T.label(empty, "Ask about quests, gear, professions or the world.", "GameFontHighlightSmall"); description:SetPoint("CENTER", 0, -18)
  local suggestions = {
    { "Quests", "What should I focus on in my current quests?" },
    { "Equipment", "How can I improve my current equipment?" },
    { "Professions", "What can I craft with my current professions and materials?" },
  }
  for i, suggestion in ipairs(suggestions) do
    local prompt = suggestion[2]
    local b = T.button(empty, suggestion[1], 114, function() input:SetText(prompt); input:SetFocus() end)
    b:SetPoint("CENTER", (i - 2) * 122, -61)
  end
  local composer = T.panel(chatView, nil, 0.02, 0.02, 0.025)
  composer:SetPoint("BOTTOMLEFT", 6, 32); composer:SetPoint("BOTTOMRIGHT", -6, 32); composer:SetHeight(102)
  if composer.SetBackdropColor then composer:SetBackdropColor(0.02, 0.02, 0.025, 0.5) end
  input = CreateFrame("EditBox", "ForeverAssistantInput", composer); UI.input = input
  input:SetPoint("TOPLEFT", 13, -12); input:SetPoint("TOPRIGHT", -13, -12); input:SetHeight(34); input:SetAutoFocus(false)
  if input.SetMaxBytes then input:SetMaxBytes(16384) end
  input:SetScript("OnEnterPressed", sendInput); input:SetScript("OnEscapePressed", function(self) self:ClearFocus() end)
  input:SetScript("OnTextChanged", function(self)
    FA.Assistant.setDraft(self:GetText()); UI.refreshActions()
    if composer.placeholder then if self:GetText() == "" then composer.placeholder:Show() else composer.placeholder:Hide() end end
  end)
  FA.Items.hookInsert(input)
  composer.placeholder = T.label(composer, "Ask your companion...", "GameFontDisableSmall"); composer.placeholder:SetPoint("TOPLEFT", 14, -23)
  local hint = T.label(composer, "Enter to send  /  Shift-click an item to attach", "GameFontDisableSmall"); hint:SetPoint("BOTTOMLEFT", 14, 17)
  send = T.button(composer, "Send", 84, composerAction, true); send:SetPoint("BOTTOMRIGHT", -10, 10)
  UI.actionButton = send
  status = T.label(chatView, UI.lastStatus or "Ready when you are.", "GameFontDisableSmall")
  status:SetPoint("BOTTOMLEFT", 10, 3); status:SetPoint("BOTTOMRIGHT", -10, 3); status:SetHeight(18); status:SetWordWrap(false)
  local statusTip = CreateFrame("Frame", nil, chatView); statusTip:SetAllPoints(status); statusTip:EnableMouse(true)
  statusTip:SetScript("OnEnter", function(self)
    if GameTooltip then GameTooltip:SetOwner(self, "ANCHOR_TOP"); GameTooltip:SetText(UI.lastStatus or "Ready when you are.", 1, 0.85, 0.55, 1, true); GameTooltip:Show() end
  end)
  statusTip:SetScript("OnLeave", function() if GameTooltip then GameTooltip:Hide() end end)
  resize = CreateFrame("Button", nil, frame); resize:SetSize(18, 18); resize:SetPoint("BOTTOMRIGHT", -2, 2)
  resize:SetNormalTexture("Interface\\ChatFrame\\UI-ChatIM-SizeGrabber-Up"); resize:SetHighlightTexture("Interface\\ChatFrame\\UI-ChatIM-SizeGrabber-Highlight")
  resize:SetScript("OnMouseDown", function(_, key) if key == "LeftButton" and not UI.preferences().locked then frame:StartSizing("BOTTOMRIGHT") end end)
  resize:SetScript("OnMouseUp", function() frame:StopMovingOrSizing(); saveLayout() end)
  frame:SetScript("OnHide", function() input:ClearFocus(); frame:StopMovingOrSizing(); saveLayout(); if UI.settings then UI.settings.cancelCapture() end end)
  frame:SetScript("OnSizeChanged", function() UI.refreshChats(); UI.scheduleRender() end)
  StaticPopupDialogs.FOREVERASSISTANT_DELETE = {
    text = "Delete this conversation and its history?\n\nIts current response will stop. Deletion syncs when the assistant is connected. Backups and general Codex history are kept.",
    button1 = "Delete chat", button2 = "Cancel",
    OnAccept = function(_, id)
      local ok, reason = FA.Assistant.deleteChat(id)
      if not ok then UI.setStatus("Could not delete chat: " .. tostring(reason)) end
    end,
    timeout = 0, whileDead = true, hideOnEscape = true,
  }
  UI.buildSettings(content); UI.applyAppearance(); frame:Hide(); UI.render()
  return frame
end

-- Visible line count uses font height plus spacing, with one spare line:
-- undercounting leaves a blank line at the top; overcounting would hide the first line.
function UI.visibleLines()
  local height = tonumber((log:GetHeight())) or 0
  local lineHeight = UI.preferences().fontSize or 14
  if measurer then
    measurer:SetText("Ag")
    lineHeight = tonumber((measurer:GetStringHeight())) or lineHeight
    measurer:SetText("")
    if lineHeight <= 0 then lineHeight = UI.preferences().fontSize or 14 end
  end
  return math.max(1, math.floor(height / (lineHeight + LINE_SPACING)) - 1)
end

-- Maximum upward scroll offset (0 means all content fits). ScrollingMessageFrame's own
-- limit lets the first line reach the bottom, leaving a blank page above it.
function UI.maxScroll()
  if not log then return 0 end
  local messages = tonumber((log.GetNumMessages and log:GetNumMessages())) or renderedLines or 0
  local limit = math.max(0, messages - UI.visibleLines())
  if log.GetMaxScrollRange then
    local native = tonumber((log:GetMaxScrollRange()))
    if native then limit = math.min(limit, native) end
  end
  return limit
end

-- Clamp the offset so the first line stops at the top edge.
function UI.clampScroll()
  if not log or not log.GetScrollOffset then return end
  local max = UI.maxScroll()
  if (tonumber((log:GetScrollOffset())) or 0) > max then log:SetScrollOffset(max) end
end

function UI.syncScroll()
  if not scrollbar then return end
  UI.clampScroll()
  local max = UI.maxScroll()
  syncing = true
  scrollbar:SetMinMaxValues(0, max)
  scrollbar:SetValue(max - (tonumber((log.GetScrollOffset and log:GetScrollOffset())) or 0))
  syncing = false
  if max > 0 then scrollbar:Show() else scrollbar:Hide() end
end

function UI.scrollLog(delta)
  if not log then return end
  if IsShiftKeyDown and IsShiftKeyDown() then
    if delta > 0 then log:PageUp() else log:PageDown() end
  else
    for _ = 1, WHEEL_LINES do if delta > 0 then log:ScrollUp() else log:ScrollDown() end end
  end
  UI.syncScroll()
end

-- Debounce redraw after window resizing.
function UI.scheduleRender()
  if renderPending then return end
  renderPending = true
  local run = function() renderPending = false; UI.render() end
  if C_Timer and C_Timer.After then C_Timer.After(0.15, run) else run() end
end

-- Add each text line as a separate message so scrolling advances one line at a time.
-- Cache wrapping until list width or font size changes.
local function addLines(text, r, g, b)
  local width = (tonumber((log:GetWidth())) or 0) - 6
  local key = width .. ":" .. tostring(UI.preferences().fontSize)
  if key ~= wrapKey then wrapCache, wrapKey = {}, key end
  local lines = wrapCache[text]
  if not lines then
    local measure = measurer and function(s) measurer:SetText(s); return measurer:GetStringWidth() end
    lines = FA.Wrap.lines(text, width, measure)
    if measurer then measurer:SetText("") end
    wrapCache[text] = lines
  end
  for _, line in ipairs(lines) do log:AddMessage(line ~= "" and line or " ", r, g, b) end
  return #lines
end

function UI.render()
  if not frame or not log then return end
  local state = FA.Assistant.state
  if not state then UI.refreshActions(); UI.refreshSettings(); return end
  local changed = renderedConversation ~= state.conversationId
  local count = #state.history
  local atBottom = changed or not log.AtBottom or log:AtBottom()
  local offset = not changed and log.GetScrollOffset and log:GetScrollOffset() or 0
  local lines = 0
  if changed then input:SetText((FA.Assistant.currentChat() or {}).draft or ""); input:ClearFocus() end
  title:SetText((FA.Assistant.currentChat() or {}).title or "New conversation")
  log:Clear()
  for _, entry in ipairs(state.history) do
    if entry.role == "user" then
      log:AddMessage("|cff7eb7d4YOU|r"); lines = lines + 1 + addLines(entry.text, 0.84, 0.87, 0.89)
    else
      local text, extra = FA.Items.renderEntry(entry)
      log:AddMessage("|cffd9b56dFOREVER ASSISTANT|r"); lines = lines + 1 + addLines(text, 0.91, 0.88, 0.81)
      for _, line in ipairs(extra) do lines = lines + addLines(line) end
    end
    log:AddMessage(" "); lines = lines + 1
  end
  for _, limitation in ipairs(FA.Assistant.session.limitations or {}) do lines = lines + addLines("|cff888888" .. limitation .. "|r") end
  if count == 0 then empty:Show() else empty:Hide() end
  -- Preserve a scrolled-up position by increasing its offset by the number of new lines.
  if atBottom then log:ScrollToBottom()
  elseif log.SetScrollOffset then log:SetScrollOffset(offset + math.max(0, lines - (renderedLines or lines))) end
  renderedConversation, renderedLines = state.conversationId, lines
  UI.syncScroll()
  UI.refreshChats(); UI.refreshActions(); UI.refreshSettings()
end

function UI.setStatus(text)
  UI.lastStatus = text
  if status then status:SetText(text or ""); UI.refreshActions() end
  if UI.settings and UI.settings.feedback then UI.settings.feedback:SetText(text or "") end
end

function UI.toggle()
  UI.ensure()
  if frame:IsShown() then frame:Hide() else UI.render(); frame:Show() end
end

function ForeverAssistant_Toggle() UI.toggle() end

SLASH_FOREVERASSISTANT1 = "/fa"
SLASH_FOREVERASSISTANT2 = "/assistant"
SlashCmdList.FOREVERASSISTANT = function(message)
  local command = string.lower((message or ""):match("^%s*(.-)%s*$"))
  if command == "stop" then FA.Assistant.stop()
  elseif command == "retry" then FA.Assistant.retry()
  elseif command == "sync" then
    local item, reason = FA.Assistant.refreshHistory()
    if not item then UI.setStatus("Could not refresh history: " .. tostring(reason)) end
  elseif command == "settings" or command == "options" then UI.ensure(); frame:Show(); UI.showSettings(true)
  elseif command == "api" then
    local present, missing = FA.Context.apiReport()
    Core.print("missing: " .. (#missing > 0 and table.concat(missing, ", ") or "none"))
    Core.print("present: " .. table.concat(present, ", "))
    Core.print("snapshot: " .. FA.Context.describe(FA.Assistant.state and FA.Assistant.state.policy))
  elseif command == "map clear" then FA.Map.clear(); Core.print("map mark removed")
  elseif command == "plan" then UI.togglePlan()
  elseif command == "alts" then
    local lines = FA.Alts.describe()
    Core.print(#lines .. " characters saved for the bridge (written on logout or /reload):")
    for _, line in ipairs(lines) do Core.print("  " .. line) end
  elseif command == "status" then
    local s = FA.Assistant.status()
    Core.print(string.format("session %s, queue %d, reads %d, slots left %d, paused %s, question %s",
      tostring(s.origin), s.queue, s.reads, s.slotsLeft, tostring(s.paused), tostring(s.active)))
  else UI.toggle() end
end
