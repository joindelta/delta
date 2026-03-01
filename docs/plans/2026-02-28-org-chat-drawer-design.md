# Org Chat Drawer Design

**Date:** 2026-02-28

## Overview

Replace the current `OrgScreen` (horizontal tab bar) + separate `RoomChatScreen` navigation with a single combined `OrgChatScreen` that uses a Discord-style left-edge swipe drawer for channel navigation.

## Navigation Changes

- Remove `Org` route from `MainStackParamList`
- Remove `RoomChat` route from `MainStackParamList`
- Add `OrgChat` route: `{ orgId: string; orgName: string }`
- `HomeScreen` org taps navigate to `OrgChat` instead of `Org`
- DM chat (`DMChat`) is unchanged

## OrgChatScreen Layout

```
┌──────────────────────────────────┐
│ ← OrgName  •  #channel   [👥][+] │  ← nav header
├──────────────────────────────────┤
│                                  │
│         chat messages            │
│                                  │
└──────────────────────────────────┘

Drawer (slides over content from left):
┌───────────────────────┐
│  [gradient banner]    │
│  Org Name             │
│  N members            │
├───────────────────────┤
│  CHANNELS             │
│  # general            │  ← active highlight
│  # room-name          │
│  + New channel        │
├───────────────────────┤
│  MEMBERS              │
│  Manage  →            │
│  Invite  →            │
└───────────────────────┘
```

## Component: OrgChatScreen

Single file: `app/src/screens/OrgChatScreen.tsx`

**State:**
- `rooms: Room[]` — loaded from `useOrgsStore`
- `activeRoomId: string | null` — defaults to first room
- `memberCount: number` — from `listOrgMembers`
- `drawerOpen: boolean` (driven by `Animated.Value drawerX`)

**On mount:**
1. `fetchRooms(orgId)` — load channel list
2. Auto-select `rooms[0]` as `activeRoomId`
3. Load messages for active room (embed existing `useMessagesStore` logic)

**Channel switch:** Updates `activeRoomId` in-place, reloads messages, closes drawer — no stack push.

## Drawer Gesture (PanResponder)

- An invisible 20px-wide `View` is absolutely positioned on the left edge covering full height
- It owns a `PanResponder` that activates on horizontal swipe right (`dx > 10`, `|dy| < dx`)
- On active drag: `drawerX` tracks `gestureState.dx` clamped to `[0, DRAWER_WIDTH]`
- On release: if `dx > DRAWER_WIDTH * 0.3` or `vx > 0.5` → snap open; else snap closed
- When drawer is open, a full-screen semi-transparent `Pressable` overlay captures taps and swipe-left to close

**Animation:** `Animated.spring` for snap open/close, `Animated.Value` driving `translateX` on the drawer panel.

## Drawer Content

**Banner:** `LinearGradient` (or fallback `View` with two colors derived from org name hash) — 120px tall, full drawer width.

**Org info:** Org name (bold, white), member count (muted).

**Channels section:** `ScrollView` with section header "CHANNELS", each row shows `# name`, active room highlighted with subtle background. Tap → switch room + close drawer.

**Create room:** `+ New channel` row at bottom of channels list → shows inline modal (same as current `OrgScreen`).

**Members section:** Two rows — "Manage members" and "Generate invite" — both navigate via `navigation.navigate`.

## Gradient Generation

Deterministic from `orgId`:
```ts
function orgGradient(seed: string): [string, string] {
  // hash seed → index into preset gradient pairs
}
```

Preset pairs (dark, moody): e.g. `['#1a1a2e', '#16213e']`, `['#0f3460', '#533483']`, etc.

## Files Changed

| File | Change |
|------|--------|
| `app/src/screens/OrgChatScreen.tsx` | New file |
| `app/src/screens/OrgScreen.tsx` | Delete |
| `app/src/navigation/RootNavigator.tsx` | Swap `Org`+`RoomChat` routes for `OrgChat`; update HomeScreen navigation call |
| `app/src/screens/HomeScreen.tsx` | Update org tap to `navigate('OrgChat', ...)` |
