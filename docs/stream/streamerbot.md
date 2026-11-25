# Streamer.bot → BetterYTS Stream

Use this for platforms BetterYTS Stream doesn't read directly, such as YouTube and Kick. Streamer.bot hears `!sr`, `!video` or `!shoutout` in chat, and broadcasts a small BetterYTS request on its local WebSocket server. BetterYTS Stream Desktop picks it up.

## Setup

1. In Streamer.bot, open **Servers/Clients → WebSocket Server**: enable it on `127.0.0.1`, port `8080`, with authentication **off**. It only listens on this computer.
2. Create an action **BetterYTS request** with an **Execute C# Code** sub-action containing the code below.
3. Add the chat-message trigger for each platform (YouTube Message, Kick Chat Message, …) to that action.
4. In BetterYTS Stream Desktop, turn on **Streamer.bot**.

## C# sub-action

```csharp
using System;

public class CPHInline
{
    public bool Execute()
    {
        CPH.TryGetArg("message", out string message);
        if (string.IsNullOrWhiteSpace(message)) return true;
        string[] parts = message.Trim().Split(new[] { ' ' }, 2);
        string kind = parts[0].ToLowerInvariant() switch { "!sr" => "song", "!video" => "video", "!shoutout" => "shoutout", _ => null };
        if (kind == null || parts.Length < 2) return true;

        CPH.TryGetArg("userId", out string userId);
        CPH.TryGetArg("user", out string user);
        // A stable per-message ID makes retries safe; fall back to a new one if the platform has none.
        if (!CPH.TryGetArg("msgId", out string id) && !CPH.TryGetArg("messageId", out id)) id = Guid.NewGuid().ToString("N");
        string platform = CPH.TryGetArg("eventSource", out string src) ? src.ToLowerInvariant() : "youtube";

        var data = new { bys = 1, platform, eventId = id, userId, user, kind, query = parts[1].Trim() };
        CPH.WebsocketBroadcastJson(Newtonsoft.Json.JsonConvert.SerializeObject(data));
        return true;
    }
}
```

## What BetterYTS accepts

These rules apply only to `General.Custom` broadcasts:
- `"bys": 1`, a non-empty `query` (cut to 512 characters) and a non-empty `userId`;
- an `eventId` of 4 or more letters, digits or `-_.:`;
- `platform` one of `youtube`, `kick`, `twitch`, `tiktok`; anything else counts as `local`;
- `kind` one of `song` (the default), `video`, `shoutout`.

Anything else is ignored. Messages over 64 KiB are dropped. Rules, limits and moderation then apply exactly as for Twitch and TikTok.

Not yet verified against a live Streamer.bot: the argument names differ by platform (`msgId` / `messageId`, `eventSource`). If a platform's requests don't arrive, check its trigger arguments in Streamer.bot.
