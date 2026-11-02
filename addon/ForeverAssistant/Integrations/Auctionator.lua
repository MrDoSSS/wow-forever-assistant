-- Auctionator prices through public API v1: read price, age and exactness
-- with protected calls and a dedicated callerID. Never read internal tables or
-- SavedVariables except two diagnostic fields: database readiness (Auctionator.Database)
-- and current market key (Auctionator.State.CurrentRealm), which the API does not expose.
-- Price is the latest known observation in copper per unit, not stock or a purchase guarantee.
local _, FA = ...
local Prices = {}
FA.Prices = Prices

local Json = FA.Json
local NULL = Json.null
local Core = FA.Core

local CALLER = "ForeverAssistant"
local REQUIRED = {
  "GetAuctionPriceByItemID", "GetAuctionPriceByItemLink",
  "GetAuctionAgeByItemID", "GetAuctionAgeByItemLink",
  "IsAuctionDataExactByItemID", "IsAuctionDataExactByItemLink",
}

local function api()
  local addon = Auctionator
  local v1 = type(addon) == "table" and type(addon.API) == "table" and addon.API.v1
  if type(v1) ~= "table" then return nil end
  for _, name in ipairs(REQUIRED) do
    if type(v1[name]) ~= "function" then return nil end
  end
  return v1
end

-- "available" | "api_unavailable" | "not_ready". Auctionator creates its database
-- on PLAYER_LOGIN; earlier nil responses for every item do not mean missing prices.
function Prices.status()
  if not api() then return "api_unavailable" end
  if type(Auctionator.Database) ~= "table" then return "not_ready" end
  return "available"
end

function Prices.version()
  local get = (C_AddOns and C_AddOns.GetAddOnMetadata) or GetAddOnMetadata
  local value = Core.try(get, "Auctionator", "Version")
  if type(value) == "string" and value ~= "" then return Core.utf8Truncate(value, 64) end
  return "unknown"
end

-- Market: Auctionator's selected database key (server and faction in LegacyAH). Without it,
-- the market is unknown and the bridge marks prices market_unverified.
function Prices.marketKey()
  local state = type(Auctionator) == "table" and Auctionator.State
  local current = type(state) == "table" and state.CurrentRealm
  if type(current) == "string" and current ~= "" then
    return Core.utf8Truncate("auctionator:" .. current, 256)
  end
  return "auctionator:unknown"
end

local function call(fn, arg)
  local ok, value = pcall(fn, CALLER, arg)
  if not ok then return nil, true end
  return value, false
end

-- Observation for one item. item is ItemInput from the question or bridge request;
-- return it unchanged so the bridge can verify the requested item set.
function Prices.observe(item, origin)
  local link = type(item.itemLink) == "string" and item.itemLink or nil
  local observation = {
    item = { itemId = item.itemId, itemLink = link or NULL },
    marketKey = "auctionator:unknown",
    unit = "per_item",
    priceCopper = NULL,
    readOriginSessionId = origin,
    readAtSessionMs = Core.sessionMs(),
    sourceObservedAtMs = NULL,
    ageDays = NULL,
    agePrecision = "unknown",
    rawExactness = NULL,
    exactness = "unknown",
    source = "auctionator_v1",
    sourceVersion = Prices.version(),
    unavailableReason = NULL,
  }
  local status = Prices.status()
  if status ~= "available" then
    observation.unavailableReason = status
    return observation
  end
  local v1 = api()
  observation.marketKey = Prices.marketKey()
  local arg = link or item.itemId
  local price, failed = call(link and v1.GetAuctionPriceByItemLink or v1.GetAuctionPriceByItemID, arg)
  if failed then
    observation.unavailableReason = "call_error"
    return observation
  end
  if type(price) ~= "number" or price <= 0 then
    observation.unavailableReason = "no_price"
    return observation
  end
  observation.priceCopper = math.floor(price + 0.5)
  local age = call(link and v1.GetAuctionAgeByItemLink or v1.GetAuctionAgeByItemID, arg)
  if type(age) == "number" and age >= 0 then
    observation.ageDays = math.floor(age)
    observation.agePrecision = "day_bucket"
  end
  -- Exactness is the raw API response. For a link, false with a known price means
  -- base-key fallback; for an ID this is inconsistent, so exactness stays unknown.
  local exact = call(link and v1.IsAuctionDataExactByItemLink or v1.IsAuctionDataExactByItemID, arg)
  if type(exact) == "boolean" then
    observation.rawExactness = exact
    if exact then
      observation.exactness = "exact"
    elseif link then
      observation.exactness = "fallback"
    end
  end
  return observation
end

-- price_lookup reply: observations for every item, or one shared reason.
function Prices.lookup(items, origin)
  local status = Prices.status()
  if status ~= "available" then return nil, status end
  local list = Json.array()
  for i, item in ipairs(items) do list[i] = Prices.observe(item, origin) end
  return list
end

-- Snapshot prices group: prices for items linked in the question.
-- An empty list with an available API means no linked items, not missing prices.
function Prices.collect(items, origin)
  local status = Prices.status()
  if status ~= "available" then return nil, status end
  local list = Json.array()
  for i, item in ipairs(items or {}) do list[i] = Prices.observe(item, origin) end
  return list, "complete"
end
