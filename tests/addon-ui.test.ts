import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { resourcePath } from '../bridge/src/paths.js';
import { QueryBody } from '../bridge/src/contracts.js';
import { LuaHost } from './lua-host.js';

function addon(ui = false): LuaHost {
  const lua = new LuaHost();
  lua.loadAddon();
  if (ui) {
    for (const file of ['Theme.lua', 'Settings.lua', 'Chat.lua', 'PlanWindow.lua']) {
      lua.runFile(resourcePath('addon', 'ForeverAssistant', 'UI', file), 'addon');
    }
  }
  lua.run('__FA_NS.Assistant.start()');
  return lua;
}

function applyDelivery(lua: LuaHost, revision: number, delivery: string): void {
  lua.run(`local A = __FA_NS.Assistant
    assert(A.applyPacket({ version = 1, publicationRevision = ${revision},
      targetCharacterKey = A.session.characterKey, targetDeliverySessionId = A.session.origin,
      acceptedMessageKeys = {}, deliveries = { ${delivery} } }))`);
}

describe('exchange slot warnings', () => {
  it('warns at 20 remaining even with the chat closed, then keeps a reload button without repeating the popup', () => {
    const lua = addon(true);
    lua.run(`local UI, A, inbound = __FA_NS.UI, __FA_NS.Assistant, __FA_NS.Inbound
      assert(#WowStub.popupCalls == 0 and UI.frame == nil)
      assert(A.ask("A pending question"))
      A.setDraft("A saved draft")
      inbound.nextSlot = 179
      inbound.readOnce()
      assert(inbound.slotsLeft() == 21 and #WowStub.popupCalls == 0)
      inbound.readOnce()
      assert(inbound.slotsLeft() == 20)
      assert(#WowStub.popupCalls == 1 and UI.frame == nil)
      assert(WowStub.popup == "FOREVERASSISTANT_RELOAD_SLOTS")
      assert(string.find(WowStub.popupCalls[1].text, "20", 1, true))
      StaticPopup_Hide("FOREVERASSISTANT_RELOAD_SLOTS")
      inbound.readOnce()
      assert(#WowStub.popupCalls == 1)
      UI.ensure()
      assert(UI.reloadButton:IsShown() and UI.slotsLabel:GetText() == "19 slots left")
      A.retry()
      assert(#WowStub.popupCalls == 1)
      local queued = #__FA_NS.Outbound.queue
      UI.reloadButton.scripts.OnClick()
      assert(WowStub.reloads == 1)
      assert(A.state.active and A.currentChat().draft == "A saved draft")
      assert(#__FA_NS.Outbound.queue == queued)
      assert(#A.state.history == 1)`);
  });

  it('escalates to exhausted immediately after the last read, once, while applying the final answer', () => {
    const lua = addon(true);
    lua.run('__FA_NS.UI.ensure(); TEST_REQUEST = assert(__FA_NS.Assistant.ask("A question"))');
    const characterKey = lua.eval('__FA_NS.Assistant.session.characterKey');
    const origin = lua.eval('__FA_NS.Assistant.session.origin');
    const requestId = lua.eval('TEST_REQUEST.requestId');
    const inbox = `ForeverAssistantInbox = { version = 1, publicationRevision = 1,
      targetCharacterKey = "${characterKey}", targetDeliverySessionId = "${origin}", acceptedMessageKeys = {},
      deliveries = { { deliveryId = "last-slot-reply", type = "reply",
        request = { characterKey = "${characterKey}", originSessionId = "${origin}", requestId = ${requestId} },
        body = { text = "The last slot still delivers the answer", status = "answer" } } } }`;
    lua.run(`local inbound = __FA_NS.Inbound
      inbound.nextSlot = 180
      inbound.readOnce()
      assert(#WowStub.popupCalls == 1)
      StaticPopup_Hide("FOREVERASSISTANT_RELOAD_SLOTS")
      inbound.nextSlot = 200
      WowStub.inbox = ${LuaHost.literal(inbox)}
      WowStub.time = 1005
      inbound.tick(WowStub.time)
      assert(inbound.slotsLeft() == 0)
      assert(inbound.paused == "slots_exhausted")
      assert(#__FA_NS.Assistant.state.history == 2 and __FA_NS.Assistant.state.active == nil)
      assert(__FA_NS.Assistant.state.history[2].text == "The last slot still delivers the answer")
      assert(#WowStub.popupCalls == 2)
      assert(string.find(WowStub.popupCalls[2].text, "used up", 1, true))
      assert(__FA_NS.UI.slotsLabel:GetText() == "Reload needed")
      local reads = inbound.stats.reads
      inbound.tick(2000)
      inbound.checkSlots()
      __FA_NS.Assistant.retry()
      inbound.tick(3000)
      assert(inbound.stats.reads == reads and #WowStub.popupCalls == 2)
      StaticPopupDialogs.FOREVERASSISTANT_RELOAD_SLOTS.OnAccept()
      assert(WowStub.reloads == 1)`);
  });

  it('counts slots already loaded by the client and starts a fresh session without stale warnings', () => {
    const lua = addon(true);
    lua.run(`local inbound = __FA_NS.Inbound
      for i = 181, 190 do WowStub.loaded[inbound.slotName(i)] = true end
      inbound.nextSlot = 179
      inbound.readOnce()
      assert(inbound.slotsLeft() == 11)
      assert(#WowStub.popupCalls == 1)
      assert(string.find(WowStub.popupCalls[1].text, "11", 1, true))`);
    const reloaded = addon(true);
    reloaded.run(`__FA_NS.UI.ensure()
      assert(__FA_NS.Inbound.slotsLeft() == 200 and __FA_NS.Inbound.slotWarningLevel == nil)
      assert(#WowStub.popupCalls == 0 and not __FA_NS.UI.reloadButton:IsShown())`);
  });

  it('reports an unavailable client API without claiming that slots are exhausted', () => {
    const lua = addon(true);
    lua.run(`C_AddOns.LoadAddOn, LoadAddOn = nil, nil
      __FA_NS.Inbound.readOnce()
      assert(__FA_NS.Inbound.paused == "slots_api_unavailable")
      assert(#WowStub.popupCalls == 0)
      assert(string.find(__FA_NS.UI.lastStatus, "API is unavailable", 1, true))`);
  });
});

describe('active plan', () => {
  // Reply with a plan: own steps, an alt step, mail, a recipe and a map point.
  function answerWithPlan(lua: LuaHost): string {
    lua.run('TEST_REQUEST = assert(__FA_NS.Assistant.ask("Plan my wands"))');
    applyDelivery(lua, 1, `{ deliveryId = "plan-reply", type = "reply", request = TEST_REQUEST, body = {
      text = "Follow the plan", status = "answer",
      locations = { { approxLocation = { title = "Camp", zoneName = "Elwynn Forest", x = 40, y = 60, basis = "b", sourceUrl = "u" } } },
      plan = { title = "Wands", steps = {
        { kind = "get", text = "Get potions", character = "Tester", item = { refId = "r1", itemId = 118, evidenceIds = { "e" } }, quantity = 2 },
        { kind = "craft", text = "Craft water", character = "Banker", item = { refId = "r2", itemId = 159, evidenceIds = { "e" } }, quantity = 5 },
        { kind = "mail", text = "Send water", character = "Tester", item = { refId = "r2", itemId = 159, evidenceIds = { "e" } }, quantity = 3,
          mailTo = "Banker", moneyCopper = 10000 },
        { kind = "learn", text = "Learn the wand", recipeSpellId = 14293 },
        { kind = "goto", text = "Go to camp", location = 1 },
      } } } }`);
    return lua.eval('__FA_NS.Assistant.state.history[2].entryId');
  }

  it('activates a plan from the answer, ticks own steps and sends its marks with the next question', () => {
    const lua = addon(true);
    const entryId = answerWithPlan(lua);
    lua.run(`local A, Plan, Items, UI = __FA_NS.Assistant, __FA_NS.Plan, __FA_NS.Items, __FA_NS.UI
      local entry = A.state.history[2]
      assert(entry.plan.title == "Wands" and entry.request.requestId == TEST_REQUEST.requestId)
      local _, lines = Items.renderEntry(entry)
      assert(string.find(lines[#lines], "|Hfaplan:activate:${entryId}|h[Make active plan]|h", 1, true), lines[#lines])
      Items.onClick("faplan:activate:${entryId}", "[Make active plan]", "LeftButton")
      local plan = assert(Plan.active())
      assert(plan.title == "Wands" and UI.planFrame:IsShown())
      assert(plan.done[1] == true, "two potions are in the bags")
      assert(not plan.done[2], "a step of another character is not ticked")
      assert(not plan.done[4])
      WowStub.knownSpells[14293] = true
      Plan.refresh()
      assert(plan.done[4] == true)
      _, lines = Items.renderEntry(entry)
      assert(string.find(lines[#lines], "[Active plan: open]", 1, true))
      local travel = UI.planStepText(plan, 5)
      assert(string.find(travel, "|Hfamap:plan:1|h[Camp", 1, true), travel)
      assert(__FA_NS.Map.pointForEntry("plan", 1).title == "Camp")
      assert(string.find(UI.planStepText(plan, 2), "|cff8a8a8aBanker:|r", 1, true))
      UI.planLink("faplan:toggle:1")
      assert(not plan.done[1] and plan.overridden[1])
      Plan.refresh()
      assert(not plan.done[1], "an unticked step stays unticked")
      assert(A.ask("What next?"))`);
    const query = JSON.parse(lua.eval('__FA_NS.Outbound.queue[#__FA_NS.Outbound.queue].bytes'));
    const ref = query.body.activePlan;
    assert.deepEqual(ref.done, [false, false, false, true, false]);
    assert.equal(ref.request.requestId, Number(lua.eval('TEST_REQUEST.requestId')));
    assert.ok(QueryBody.safeParse(query.body).success);
  });

  it('fills a letter at the mailbox with split stacks and gold, and ticks it after sending', () => {
    const lua = addon(true);
    const entryId = answerWithPlan(lua);
    lua.run(`local Plan, UI = __FA_NS.Plan, __FA_NS.UI
      assert(Plan.activate(__FA_NS.Assistant.state.history[2]))
      local plan = Plan.active()
      assert(plan.entryId == "${entryId}")
      local result, reason = Plan.fillMail("Banker")
      assert(not result and reason == "mailbox_closed")
      Plan.onEvent("MAIL_SHOW")
      assert(UI.planFrame:IsShown())
      local recipients = Plan.recipients()
      assert(#recipients == 1 and recipients[1] == "Banker")
      UI.planLink("faplan:mail:1")
      assert(SendMailNameEditBox:GetText() == "Banker" and SendMailSubjectEditBox:GetText() == "Wands")
      assert(#WowStub.mail.attachments == 1)
      assert(WowStub.mail.attachments[1].itemId == 159 and WowStub.mail.attachments[1].count == 3)
      assert(WowStub.mail.money == 10000)
      assert(not plan.done[3])
      Plan.onEvent("MAIL_SEND_SUCCESS")
      assert(plan.done[3] == true and plan.sent[3] == 3)
      assert(#Plan.recipients() == 0)
      UI.planLink("faplan:clear")
      assert(WowStub.popup == "FOREVERASSISTANT_CLEAR_PLAN")
      StaticPopupDialogs.FOREVERASSISTANT_CLEAR_PLAN.OnAccept()
      assert(Plan.active() == nil and Plan.queryRef() == nil)`);
  });

  it('addresses the letter by the full name of the saved alt and matches names with or without a surname', () => {
    const lua = addon(true);
    answerWithPlan(lua);
    lua.run(`local Plan, Alts = __FA_NS.Plan, __FA_NS.Alts
      WowStub.surname = "Forever"
      assert(Alts.fullName() == "Tester", "a surname equal to the realm is the realm")
      WowStub.surname = "Smith"
      assert(Alts.fullName() == "Tester Smith")
      assert(Plan.isMine({ character = "Tester Smith" }) and Plan.isMine({ character = "Tester" }))
      assert(not Plan.isMine({ character = "Tester Jones" }) and not Plan.isMine({ character = "Banker" }))
      assert(Plan.activate(__FA_NS.Assistant.state.history[2]))
      Plan.onEvent("MAIL_SHOW")
      local result = assert(Plan.fillMail("Banker"))
      assert(result.noSurname and SendMailNameEditBox:GetText() == "Banker")
      __FA_NS.UI.planLink("faplan:mail:1")
      ForeverAssistantDB.alts.other = { identity = { displayName = "Banker" }, summary = { fullName = "Banker Ironfoot" } }
      result = assert(Plan.fillMail("Banker"))
      assert(not result.noSurname and SendMailNameEditBox:GetText() == "Banker Ironfoot")
      assert(Plan.mailName("banker ironfoot") == "Banker Ironfoot")`);
  });

  it('stays open on Esc, fits its height to the steps and takes its look from the scrolling settings', () => {
    const lua = addon(true);
    answerWithPlan(lua);
    lua.run(`local Plan, UI = __FA_NS.Plan, __FA_NS.UI
      assert(Plan.activate(__FA_NS.Assistant.state.history[2]))
      UI.showPlan()
      for _, name in ipairs(UISpecialFrames) do assert(name ~= "ForeverAssistantPlanFrame") end
      local prefs = UI.planPreferences()
      local frame = UI.planFrame
      assert(prefs.autoHeight and frame:GetHeight() < prefs.height, "a short plan shrinks the window")
      UI.planResize.scripts.OnMouseDown(UI.planResize, "LeftButton")
      frame:SetSize(500, 600)
      UI.planResize.scripts.OnMouseUp(UI.planResize)
      assert(not prefs.autoHeight and prefs.width == 500 and prefs.height == 600, "the corner sets a fixed size")
      assert(frame:GetHeight() == 600 and frame:GetWidth() == 500)
      -- The list grows upward: pad a short plan with blank lines to keep text at the top.
      assert(UI.planRenderedLines() == math.floor((600 - 96) / 18) - 1, UI.planRenderedLines())
      UIParent.height = 300
      UI.renderPlan()
      assert(frame:GetHeight() == 292, "the window stops at the bottom of the screen")
      UIParent.height = nil
      UI.ensure(); UI.showSettings(true)
      UI.settings.planAuto:SetChecked(true); UI.settings.planAuto.scripts.OnClick(UI.settings.planAuto)
      assert(prefs.autoHeight and frame:GetHeight() < 600, "auto height fits the steps again")
      local settings = UI.settings
      for _ = 1, 10 do settings.controls["plan.opacity"].minus.scripts.OnClick() end
      assert(prefs.opacity == 0 and settings.controls["plan.opacity"].label:GetText() == "0%")
      assert(UI.preferences().opacity > 0.6, "the chat background is a separate setting")
      settings.controls["plan.fontSize"].plus.scripts.OnClick()
      assert(prefs.fontSize == 15)
      settings.planLock:SetChecked(true); settings.planLock.scripts.OnClick(settings.planLock)
      assert(prefs.locked)
      settings.scrollTo(10000)
      assert(settings.offset > 0 and settings.bar:IsShown(), "the settings scroll to the plan section")
      settings.scroll.scripts.OnMouseWheel(settings.scroll, 1)
      assert(settings.offset < 10000)
      settings.scrollTo(-5)
      assert(settings.offset == 0)`);
  });

  it('ticks logging in, emptied letters, a reached skill and a reached place by itself', () => {
    const lua = addon(true);
    lua.run('TEST_REQUEST = assert(__FA_NS.Assistant.ask("Level tailoring"))');
    applyDelivery(lua, 1, `{ deliveryId = "levelling", type = "reply", request = TEST_REQUEST, body = {
      text = "Plan", status = "answer",
      locations = { { approxLocation = { title = "Trainer", zoneName = "Elwynn Forest", x = 41.5, y = 65.5, basis = "b", sourceUrl = "u" } } },
      plan = { title = "Tailoring", steps = {
        { kind = "login", text = "Log in", character = "Tester" },
        { kind = "login", text = "Log in on the alt", character = "Banker" },
        { kind = "collect", text = "Take the gold", character = "Tester", mailFrom = "Banker" },
        { kind = "craft", text = "Bolts up to 50", character = "Tester", item = { refId = "r", itemId = 2996, evidenceIds = { "e" } },
          quantity = 33, skillId = 197, skillRank = 50 },
        { kind = "craft", text = "Belts up to 100", character = "Tester", skillId = 197, skillRank = 100 },
        { kind = "goto", text = "Go to the trainer", character = "Tester", location = 1 },
      } } } }`);
    lua.run(`local Plan, UI = __FA_NS.Plan, __FA_NS.UI
      assert(Plan.activate(__FA_NS.Assistant.state.history[2]))
      local plan = Plan.active()
      assert(plan.done[1] and not plan.done[2], "only the current character is logged in")
      assert(plan.done[4], "tailoring 75 reaches skill 50 without 33 bolts in the bags")
      assert(not plan.done[5])
      assert(string.find(UI.planStepText(plan, 5), "skill 75 / 100", 1, true), UI.planStepText(plan, 5))
      assert(plan.done[6], "the player stands at the point")
      local letters = { { "Banker", 40000, 0 } }
      function GetInboxNumItems() return #letters end
      function GetInboxHeader(i) local l = letters[i]; return nil, nil, l[1], "Gold", l[2], 0, 30, l[3] end
      Plan.onEvent("MAIL_SHOW")
      assert(not plan.done[3] and plan.seen[3], "the letter is still there")
      letters[1][2] = 0
      Plan.onEvent("MAIL_INBOX_UPDATE")
      assert(plan.done[3], "the gold is taken")`);
  });

  it('replaces the active plan with a correction from the chat and keeps the ticks of unchanged steps', () => {
    const lua = addon(true);
    answerWithPlan(lua);
    lua.run(`local A, Plan = __FA_NS.Assistant, __FA_NS.Plan
      assert(Plan.activate(A.state.history[2]))
      local plan = Plan.active()
      Plan.toggle(4)
      assert(plan.done[1] and plan.done[4], "own potions and a ticked recipe")
      TEST_REQUEST = assert(A.ask("Buy the water from a vendor instead"))
      __FA_OLD_STEPS = plan.steps`);
    applyDelivery(lua, 2, `{ deliveryId = "revision", type = "reply", request = TEST_REQUEST, body = {
      text = "Changed step 2", status = "answer",
      plan = { title = "Wands", revises = true, steps = {
        __FA_OLD_STEPS[1],
        { kind = "get", text = "Buy water from a vendor", character = "Banker", item = { refId = "r2", itemId = 159, evidenceIds = { "e" } }, quantity = 5 },
        __FA_OLD_STEPS[3],
        __FA_OLD_STEPS[4],
      } } } }`);
    lua.run(`local A, Plan, UI = __FA_NS.Assistant, __FA_NS.Plan, __FA_NS.UI
      local plan = Plan.active()
      assert(plan.entryId == A.state.history[4].entryId, "the correction became the active plan without a click")
      assert(#plan.steps == 4 and plan.steps[2].text == "Buy water from a vendor")
      assert(plan.done[1] and plan.done[4] and not plan.done[2], "ticks of unchanged steps are kept")
      assert(string.find(UI.lastStatus, "plan was updated", 1, true), UI.lastStatus)
      -- A new plan without a revision flag waits for the button.
      TEST_REQUEST = assert(A.ask("Another plan"))`);
    applyDelivery(lua, 3, `{ deliveryId = "other", type = "reply", request = TEST_REQUEST, body = {
      text = "Other", status = "answer", plan = { title = "Other", steps = { { kind = "do", text = "Something" } } } } }`);
    lua.run(`assert(__FA_NS.Plan.active().title == "Wands")`);
  });

  it('toggles fit and lock from the icons in the plan header', () => {
    const lua = addon(true);
    answerWithPlan(lua);
    lua.run(`local Plan, UI = __FA_NS.Plan, __FA_NS.UI
      assert(Plan.activate(__FA_NS.Assistant.state.history[2]))
      UI.showPlan()
      local prefs = UI.planPreferences()
      assert(prefs.autoHeight and UI.planFitIcon.on and not UI.planLockIcon.on)
      UI.planFitIcon.scripts.OnClick(UI.planFitIcon)
      assert(not prefs.autoHeight and not UI.planFitIcon.on)
      assert(prefs.height == UI.planFrame:GetHeight(), "the current height is kept")
      UI.planLockIcon.scripts.OnClick(UI.planLockIcon)
      assert(prefs.locked and UI.planLockIcon.on and not UI.planResize:IsShown())
      UI.planSettingsIcon.scripts.OnClick(UI.planSettingsIcon)
      assert(UI.frame:IsShown() and UI.settings:IsShown(), "the gear opens the assistant settings")
      assert(UI.settings.offset > 0, "scrolled to the plan window section")
      assert(UI.settings.planLock:GetChecked() and not UI.settings.planAuto:GetChecked(), "settings follow the icons")`);
  });

  it('keeps the plan of an answer when the bridge history page has it or omits it', () => {
    const lua = addon(true);
    answerWithPlan(lua);
    lua.run(`local A = __FA_NS.Assistant
      local entry = A.state.history[2]
      __FA_HISTORY = { { entryId = A.state.history[1].entryId, role = "user", text = "Plan my wands" },
        { entryId = entry.entryId, role = "assistant", text = "Follow the plan", request = TEST_REQUEST } }`);
    applyDelivery(lua, 2, `{ deliveryId = "history-1", type = "history", body = {
      conversationId = __FA_NS.Assistant.state.conversationId, entries = __FA_HISTORY } }`);
    lua.run(`local entry = __FA_NS.Assistant.state.history[2]
      assert(entry.plan and entry.plan.title == "Wands" and entry.request.requestId == TEST_REQUEST.requestId)`);
  });
});

describe('saved conversations', () => {
  it('deletes the last chat immediately and keeps its deletion across reload without restoring late replies', () => {
    const lua = addon();
    lua.run(`local A = __FA_NS.Assistant
      DELETED_ID = A.state.conversationId
      DELETED_REQUEST = assert(A.ask("Remove this conversation"))
      DELETE_OPERATION = assert(A.deleteChat())
      EMPTY_ID = A.state.conversationId
      assert(EMPTY_ID ~= DELETED_ID)
      assert(#A.state.chats == 1 and #A.state.history == 0)
      assert(A.state.active == nil)
      assert(A.state.pendingDeletes[DELETE_OPERATION].old == DELETED_ID)
      A.start()
      assert(#A.state.chats == 1 and A.state.conversationId == EMPTY_ID)
      assert(A.state.pendingDeletes[DELETE_OPERATION])
      assert(A.ask("A new question"))
      UI_STATUS_BEFORE_ACK = __FA_NS.UI.lastStatus`);
    applyDelivery(lua, 1, `{ deliveryId = "late-reply", type = "reply", request = DELETED_REQUEST,
      body = { text = "Do not restore this", status = "answer" } }`);
    applyDelivery(lua, 2, `{ deliveryId = "late-error", type = "error", request = DELETED_REQUEST,
      body = { text = "Do not replace the new question status" } }`);
    applyDelivery(lua, 3, `{ deliveryId = "delete-confirmed", type = "cleared", body = {
      operationId = DELETE_OPERATION, oldConversationId = DELETED_ID,
      replacementConversationId = EMPTY_ID } }`);
    assert.equal(lua.eval('__FA_NS.Assistant.state.pendingDeletes[DELETE_OPERATION]'), 'nil');
    assert.equal(lua.eval('__FA_NS.Assistant.state.conversationId == EMPTY_ID'), 'true');
    assert.equal(lua.eval('#__FA_NS.Assistant.state.history'), '1');
    assert.equal(lua.eval('__FA_NS.Assistant.state.history[1].text'), 'A new question');
    assert.equal(lua.eval('__FA_NS.Assistant.state.active ~= nil'), 'true');
    assert.equal(lua.eval('__FA_NS.UI.lastStatus == UI_STATUS_BEFORE_ACK'), 'true');
  });

  it('leaves the conversation and response intact if the deletion cannot be queued', () => {
    const lua = addon();
    lua.run(`local A = __FA_NS.Assistant
      local id = A.state.conversationId
      assert(A.ask("Keep this question"))
      while #__FA_NS.Outbound.queue < __FA_NS.Outbound.MAX_QUEUE do
        assert(A.send("RECEIPTS", function() return { deliveryIds = __FA_NS.Json.array() } end))
      end
      local operation, reason = A.deleteChat()
      assert(operation == nil and reason == "queue_full")
      assert(A.state.conversationId == id and #A.state.chats == 1)
      assert(A.state.active and A.state.history[1].text == "Keep this question")
      assert(next(A.state.pendingDeletes) == nil)`);
  });

  it('migrates the previous conversation and keeps independent histories and drafts across reload', () => {
    const lua = new LuaHost();
    lua.loadAddon();
    lua.run(`local A = __FA_NS.Assistant
      local key = A.characterKeyOf(A.collectIdentity())
      ForeverAssistantDB = { version = 1, characters = { [key] = {
        conversationId = string.rep("a", 32), history = { { entryId = "old", role = "user", text = "Old question" } }
      } } }
      A.start()
      A.setDraft("First draft")
      assert(A.newChat())
      SECOND_ID = A.state.conversationId
      A.addHistory({ entryId = "second", role = "user", text = "Second question" })
      A.setDraft("Second draft")
      assert(A.selectChat(string.rep("a", 32)))
      assert(A.state.history[1].text == "Old question")
      assert(A.currentChat().draft == "First draft")
      A.start()
      assert(#A.state.chats == 2)
      assert(A.selectChat(SECOND_ID))
      assert(A.state.history[1].text == "Second question")
      assert(A.currentChat().draft == "Second draft")`);
    assert.equal(lua.eval('ForeverAssistantDB.version'), '2');
  });

  it('blocks switching during a question but switches locally even when the transport queue is full', () => {
    const lua = addon();
    lua.run(`local A = __FA_NS.Assistant
      FIRST_ID = A.state.conversationId
      A.addHistory({ entryId = "first", role = "user", text = "Keep me" })
      assert(A.newChat())
      SECOND_ID = A.state.conversationId
      assert(A.ask("A question"))
      local ok, reason = A.selectChat(FIRST_ID)
      assert(not ok and reason == "busy")
      assert(A.state.conversationId == SECOND_ID)
      A.stop()
      while #__FA_NS.Outbound.queue < __FA_NS.Outbound.MAX_QUEUE do
        assert(A.send("RECEIPTS", function() return { deliveryIds = __FA_NS.Json.array() } end))
      end
      local sequence, startedAt, reads = A.session.sequence, __FA_NS.Inbound.startedAt, __FA_NS.Inbound.stats.reads
      ok, reason = A.selectChat(FIRST_ID)
      assert(ok)
      assert(A.state.conversationId == FIRST_ID)
      assert(A.state.history[1].text == "Keep me")
      local count = #A.state.chats
      assert(A.newChat())
      assert(#A.state.chats == count + 1)
      assert(A.session.sequence == sequence)
      assert(__FA_NS.Inbound.startedAt == startedAt and __FA_NS.Inbound.stats.reads == reads)
      assert(#__FA_NS.Outbound.queue == __FA_NS.Outbound.MAX_QUEUE)`);
  });

  it('refreshes history only when explicitly requested', () => {
    const lua = addon();
    lua.run(`local A = __FA_NS.Assistant
      local count = #__FA_NS.Outbound.queue
      for _ = 1, 20 do assert(A.newChat()) end
      assert(#__FA_NS.Outbound.queue == count)
      assert(A.refreshHistory())
      assert(#__FA_NS.Outbound.queue == count + 1)
      local item = __FA_NS.Outbound.queue[count + 1]
      assert(item.type == "HELLO")`);
    const message = JSON.parse(lua.eval('__FA_NS.Outbound.queue[#__FA_NS.Outbound.queue].bytes'));
    assert.equal(message.body.conversationId, lua.eval('__FA_NS.Assistant.state.conversationId'));
  });

  it('ignores stale hello/history and clears only the selected conversation cache', () => {
    const lua = addon();
    lua.run(`local A = __FA_NS.Assistant
      FIRST_ID = A.state.conversationId
      A.addHistory({ entryId = "first", role = "user", text = "Keep me" })
      assert(A.newChat())
      local function packet(revision, delivery)
        assert(A.applyPacket({ version = 1, publicationRevision = revision,
          targetCharacterKey = A.session.characterKey, targetDeliverySessionId = A.session.origin,
          acceptedMessageKeys = {}, deliveries = { delivery } }))
      end
      SECOND_ID = A.state.conversationId
      packet(1, { deliveryId = "old-hello", type = "hello", body = { conversationId = FIRST_ID } })
      packet(2, { deliveryId = "old-history", type = "history", body = { conversationId = FIRST_ID, entries = {} } })
      assert(A.state.conversationId == SECOND_ID)
      A.addHistory({ entryId = "second", role = "user", text = "Remove me" })
      assert(A.clearHistory())
      local pending = A.state.pendingClear
      packet(3, { deliveryId = "cleared", type = "cleared", body = {
        operationId = pending.operationId, oldConversationId = SECOND_ID, replacementConversationId = pending.replacement } })
      assert(#A.currentChat().history == 0)
      assert(A.currentChat().id ~= SECOND_ID)
      assert(A.selectChat(FIRST_ID))
      assert(A.state.history[1].text == "Keep me")`);
  });
});

describe('chat window and shortcut settings', () => {
  it('stops scrolling up when the first line reaches the top instead of leaving an empty page', () => {
    const lua = addon(true);
    lua.run(`local UI, A = __FA_NS.UI, __FA_NS.Assistant
      UI.ensure()
      local log = ForeverAssistantLog
      local count, offset = 0, 0
      log.Clear = function() count, offset = 0, 0 end
      log.AddMessage = function() count = count + 1 end
      log.GetNumMessages = function() return count end
      log.GetScrollOffset = function() return offset end
      log.SetScrollOffset = function(_, value) offset = value end
      log.ScrollUp = function() offset = math.min(offset + 1, count - 1) end
      log.ScrollToBottom = function() offset = 0 end
      log.GetHeight = function() return 200 end
      UI.preferences().fontSize = 14
      for i = 1, 10 do A.addHistory({ entryId = "e" .. i, role = "assistant", text = "Line " .. i }) end
      -- 10 replies of 3 lines each (header, text, spacing); floor(200 / 20) - 1 = 9 visible lines.
      assert(count == 30, "lines " .. count)
      assert(UI.maxScroll() == 21, "max " .. UI.maxScroll())
      for _ = 1, 40 do UI.scrollLog(1) end
      assert(offset == 21, "offset " .. offset)`);
  });

  it('adds replies to the log line by line and scrolls two lines per wheel step', () => {
    const lua = addon(true);
    lua.run(`local UI, A = __FA_NS.UI, __FA_NS.Assistant
      UI.ensure()
      TEST_LINES, TEST_UP = {}, 0
      ForeverAssistantLog.AddMessage = function(_, text) TEST_LINES[#TEST_LINES + 1] = text end
      ForeverAssistantLog.ScrollUp = function() TEST_UP = TEST_UP + 1 end
      A.addHistory({ entryId = "multi", role = "assistant", text = "First paragraph.\\nSecond paragraph.\\nThird." })
      local found = {}
      for _, line in ipairs(TEST_LINES) do found[line] = true end
      assert(found["First paragraph."] and found["Second paragraph."] and found["Third."], table.concat(TEST_LINES, "|"))
      UI.scrollLog(1)
      assert(TEST_UP == 2, "two lines per wheel step")`);
  });

  it('uses one Send/Stop control and keeps the next draft when stopping the response', () => {
    const lua = addon(true);
    lua.run(`local UI, A = __FA_NS.UI, __FA_NS.Assistant
      UI.toggle()
      local action = UI.actionButton
      assert(action.label:GetText() == "Send" and not action.enabled)
      UI.input:SetText("First question")
      assert(action.enabled)
      action.scripts.OnClick()
      assert(A.state.active and UI.input:GetText() == "")
      assert(action.label:GetText() == "Stop" and action.enabled)
      UI.input:SetText("Next question draft")
      assert(action.label:GetText() == "Stop")
      action.scripts.OnClick()
      assert(A.state.active == nil)
      assert(action.label:GetText() == "Send" and action.enabled)
      assert(UI.input:GetText() == "Next question draft")
      local questions = 0
      for _, item in ipairs(__FA_NS.Outbound.queue) do if item.type == "QUERY" then questions = questions + 1 end end
      assert(questions == 1)
      local function check(parent)
        for _, child in ipairs(parent.children) do
          if child.kind == "Button" and child.label then
            local label = child.label:GetText()
            assert(label ~= "Retry" and label ~= "Latest" and label ~= "Clear chat")
          end
          check(child)
        end
      end
      check(UI.frame)`);
  });

  it('shows a clarification once when the model repeats it in the text', () => {
    const lua = addon(true);
    const ask = (id: string, text: string, clarification: string) => {
      lua.run(`__FA_NS.UI.toggle(); __FA_NS.UI.input:SetText("123123"); __FA_NS.UI.actionButton.scripts.OnClick()
        TEST_REQUEST = __FA_NS.Assistant.state.active.key; __FA_NS.UI.toggle()`);
      applyDelivery(lua, Number(id), `{ deliveryId = "reply-${id}", type = "reply", request = TEST_REQUEST,
        body = { text = ${LuaHost.literal(text)}, status = "needs_data", clarification = ${LuaHost.literal(clarification)} } }`);
      const history = '__FA_NS.Assistant.state.history';
      return lua.eval(`${history}[#${history}].text`);
    };
    assert.equal(ask('1', 'What would you like help with?', 'What would you like help with? '), 'What would you like help with?');
    assert.equal(ask('2', 'The item is unclear.', 'Which item do you mean?'), 'The item is unclear.\n\nWhich item do you mean?');
  });

  it('returns to Send when a response finishes', () => {
    const lua = addon(true);
    lua.run(`__FA_NS.UI.toggle(); __FA_NS.UI.input:SetText("A question"); __FA_NS.UI.actionButton.scripts.OnClick()
      TEST_REQUEST = __FA_NS.Assistant.state.active.key`);
    applyDelivery(lua, 1, `{ deliveryId = "reply", type = "reply", request = TEST_REQUEST,
      body = { text = "An answer", status = "answer" } }`);
    assert.equal(lua.eval('__FA_NS.UI.actionButton.label:GetText()'), 'Send');
    assert.equal(lua.eval('__FA_NS.UI.actionButton.enabled'), 'false');
  });

  it('confirms deletion of the original chat and preserves the selected chat and its active response', () => {
    const lua = addon(true);
    lua.run(`local UI, A = __FA_NS.UI, __FA_NS.Assistant
      UI.toggle()
      DELETED_ID = A.state.conversationId
      UI.deleteButton.scripts.OnClick()
      assert(WowStub.popup == "FOREVERASSISTANT_DELETE")
      assert(WowStub.popupData == DELETED_ID)
      assert(#A.state.chats == 1, "opening the confirmation does not delete anything")
      assert(A.newChat())
      SELECTED_ID = A.state.conversationId
      assert(A.ask("Keep working on this"))
      StaticPopupDialogs.FOREVERASSISTANT_DELETE.OnAccept(nil, WowStub.popupData)
      assert(#A.state.chats == 1 and A.state.chats[1].id == SELECTED_ID)
      assert(A.state.active and A.state.history[1].text == "Keep working on this")
      assert(UI.actionButton.label:GetText() == "Stop")`);
    const messages = JSON.parse(lua.eval(`(function()
      local out = __FA_NS.Json.array()
      for _, item in ipairs(__FA_NS.Outbound.queue) do out[#out + 1] = item.bytes end
      return __FA_NS.Json.encode(out)
    end)()`)) as string[];
    const deletion = messages.map((bytes) => JSON.parse(bytes)).find((message) => message.type === 'CLEAR_HISTORY');
    assert.equal(deletion.body.deleteChat, true);
    assert.equal(deletion.body.conversationId, lua.eval('DELETED_ID'));
  });

  for (const modern of [false, true]) {
    it(`attaches items through the ${modern ? 'ChatFrameUtil' : 'legacy'} client API without input focus`, () => {
      const lua = addon(true);
      lua.run(`local function nativeInsert(link)
          if WowStub.nativeChat and WowStub.nativeChat:HasFocus() then WowStub.nativeChat:Insert(link); return true end
          return false
        end
        local function activeWindow() return WowStub.nativeChat end
        if ${modern} then
          ChatFrameUtil = { InsertLink = nativeInsert, GetActiveWindow = activeWindow }
          ChatEdit_InsertLink = function(link) return ChatFrameUtil.InsertLink(link) end
        else
          ChatEdit_InsertLink, ChatEdit_GetActiveWindow = nativeInsert, activeWindow
        end
        local UI, A = __FA_NS.UI, __FA_NS.Assistant
        UI.toggle()
        local link = "|cff1eff00|Hitem:7046::::::::12:::::::|h[Azure Silk Hood]|h|r"
        UI.input:ClearFocus()
        ChatEdit_InsertLink(link)
        assert(UI.input:GetText() == link, "insert exactly once through the client wrapper")
        assert(UI.input:HasFocus())
        assert(A.currentChat().draft == link)
        UI.input:ClearFocus()
        WowStub.nativeChat = CreateFrame("EditBox", nil, UIParent)
        WowStub.nativeChat:SetFocus()
        ChatEdit_InsertLink(link)
        assert(UI.input:GetText() == link, "do not steal links from the game chat")
        assert(WowStub.nativeChat:GetText() == link)
        WowStub.nativeChat:ClearFocus()
        UI.showSettings(true)
        ChatEdit_InsertLink(link)
        assert(UI.input:GetText() == link, "settings do not accept attachments")
        UI.showSettings(false)
        UI.frame:Hide()
        ChatEdit_InsertLink(link)
        assert(UI.input:GetText() == link, "hidden assistant does not accept attachments")`);
    });
  }

  it('ships real Unicode glyphs for mixed Russian and English text', () => {
    const font = readFileSync(resourcePath('addon', 'ForeverAssistant', 'Fonts', 'NotoSans-Regular.ttf'));
    assert.equal(font.readUInt32BE(0), 0x00010000, 'static TrueType font');
    let cmap = 0;
    for (let i = 0; i < font.readUInt16BE(4); i++) {
      const record = 12 + i * 16;
      if (font.toString('ascii', record, record + 4) === 'cmap') cmap = font.readUInt32BE(record + 8);
    }
    assert.ok(cmap, 'character map exists');
    let table = 0;
    for (let i = 0; i < font.readUInt16BE(cmap + 2); i++) {
      const record = cmap + 4 + i * 8;
      const platform = font.readUInt16BE(record);
      const offset = cmap + font.readUInt32BE(record + 4);
      if ((platform === 0 || (platform === 3 && font.readUInt16BE(record + 2) === 1)) && font.readUInt16BE(offset) === 4) table = offset;
    }
    assert.ok(table, 'Unicode BMP character map exists');
    const segments = font.readUInt16BE(table + 6) / 2;
    const ends = table + 14;
    const starts = ends + segments * 2 + 2;
    const deltas = starts + segments * 2;
    const ranges = deltas + segments * 2;
    function glyph(code: number): number {
      for (let i = 0; i < segments; i++) {
        if (code < font.readUInt16BE(starts + i * 2) || code > font.readUInt16BE(ends + i * 2)) continue;
        const delta = font.readInt16BE(deltas + i * 2);
        const range = font.readUInt16BE(ranges + i * 2);
        if (range === 0) return (code + delta) & 0xffff;
        const id = font.readUInt16BE(ranges + i * 2 + range + (code - font.readUInt16BE(starts + i * 2)) * 2);
        return id === 0 ? 0 : (id + delta) & 0xffff;
      }
      return 0;
    }
    const characters = [...Array.from({ length: 95 }, (_, i) => String.fromCodePoint(32 + i)),
      ...Array.from({ length: 64 }, (_, i) => String.fromCodePoint(0x0410 + i)), '\u0401', '\u0451', '№', '—'];
    for (const character of characters) assert.ok(glyph(character.codePointAt(0)!), `missing glyph: ${character}`);
  });

  it('uses the bundled font for Russian drafts, replies and conversation titles after changing text size', () => {
    const lua = addon(true);
    lua.run(`local UI, A = __FA_NS.UI, __FA_NS.Assistant
      UI.ensure()
      TEST_RUSSIAN = "\u041f\u0440\u0438\u0432\u0435\u0442, \u0451\u0436! \u0413\u0434\u0435 \u043d\u0430\u0439\u0442\u0438 \u043f\u043e\u0441\u043e\u0445?"
      UI.input:SetText(TEST_RUSSIAN)
      A.currentChat().title = TEST_RUSSIAN
      A.addHistory({ entryId = "russian-reply", role = "assistant", text = TEST_RUSSIAN })
      UI.preferences().fontSize = 18
      UI.applyAppearance()
      assert(UI.input:GetText() == TEST_RUSSIAN)
      assert(select(1, UI.input:GetFont()) == UI.Theme.contentFont)
      assert(select(2, UI.input:GetFont()) == 18)
      assert(select(1, ForeverAssistantLog:GetFont()) == UI.Theme.contentFont)
      local titles = 0
      local function check(parent)
        for _, child in ipairs(parent.children) do
          if child.kind == "FontString" and child.text == TEST_RUSSIAN then
            assert(select(1, child:GetFont()) == UI.Theme.contentFont)
            titles = titles + 1
          end
          check(child)
        end
      end
      check(UI.frame)
      assert(titles == 2, "conversation heading and sidebar title")`);
  });

  it('explains how to load the bundled font when the client rejects the new file', () => {
    const lua = addon(true);
    lua.run('WowStub.fontUnavailable = __FA_NS.UI.Theme.contentFont; __FA_NS.UI.ensure()');
    assert.match(lua.eval('__FA_NS.UI.lastStatus'), /Fully restart WoW/);
  });

  it('opens the actual UI modules, switches drafts and preserves layout preferences', () => {
    const lua = addon(true);
    lua.run(`local UI, A = __FA_NS.UI, __FA_NS.Assistant
      UI.toggle()
      assert(UI.frame:IsShown())
      FIRST_ID = A.state.conversationId
      UI.input:SetText("Keep this draft")
      assert(A.newChat())
      assert(UI.input:GetText() == "")
      UI.input:SetText("A different draft")
      assert(A.selectChat(FIRST_ID))
      assert(UI.input:GetText() == "Keep this draft")
      UI.showSettings(true)
      assert(UI.settings:IsShown())
      UI.preferences().fontSize = 18
      UI.preferences().locked = true
      UI.applyAppearance()
      UI.refreshSettings()
      assert(UI.settings.controls.fontSize.label:GetText() == "18")
      UI.toggle()
      assert(not UI.frame:IsShown())
      assert(ForeverAssistantDB.ui.fontSize == 18)
      SlashCmdList.FOREVERASSISTANT("settings")
      assert(UI.frame:IsShown() and UI.settings:IsShown())`);
  });

  it('checks conflicts and combat before saving a shortcut to the current binding set', () => {
    const lua = addon(true);
    lua.run(`local UI = __FA_NS.UI
      WowStub.bindings["CTRL-J"] = "TOGGLEQUESTLOG"
      WowStub.bindings["ALT-F"] = "FOREVERASSISTANT_TOGGLE"
      local ok, reason = UI.assignBinding("CTRL-J")
      assert(not ok and reason == "conflict")
      assert(WowStub.bindings["ALT-F"] == "FOREVERASSISTANT_TOGGLE")
      assert(UI.assignBinding("CTRL-J", true))
      assert(WowStub.bindings["CTRL-J"] == "FOREVERASSISTANT_TOGGLE")
      assert(WowStub.bindings["ALT-F"] == nil)
      assert(WowStub.savedBindingSet == 2)
      WowStub.combat = true
      assert(not UI.assignBinding("CTRL-K"))
      assert(WowStub.bindings["CTRL-J"] == "FOREVERASSISTANT_TOGGLE")
      WowStub.combat = false
      assert(UI.assignBinding(nil))
      assert(WowStub.bindings["CTRL-J"] == nil)`);
  });

  it('captures modified keys and cancels capture when the window closes', () => {
    const lua = addon(true);
    lua.run(`local UI = __FA_NS.UI
      UI.ensure(); UI.frame:Show(); UI.showSettings(true)
      local panel = UI.settings
      local catcher
      for _, child in ipairs(panel.children) do if child.scripts.OnKeyDown then catcher = child end end
      assert(catcher)
      IsControlKeyDown = function() return true end
      panel.capture.scripts.OnClick()
      catcher.scripts.OnKeyDown(catcher, "J")
      assert(WowStub.bindings["CTRL-J"] == "FOREVERASSISTANT_TOGGLE")
      assert(not panel.capturing)
      panel.capture.scripts.OnClick()
      UI.frame:Hide()
      assert(not catcher:IsShown() and not panel.capturing)`);
  });
});
