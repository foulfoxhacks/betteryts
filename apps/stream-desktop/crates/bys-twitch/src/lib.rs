//! Twitch source for BetterYTS Stream, on Twitch's official interfaces only:
//! - [`irc`]: chat over IRC with IRCv3 tags (`wss://irc-ws.chat.twitch.tv`);
//! - [`eventsub`]: follows, subs, cheers, raids and channel points over EventSub WebSocket;
//! - [`oauth`]: sign-in with the OAuth device flow (no client secret on the user's machine).
//!
//! Tokens are stored only in the OS keychain (bys-store) and requested with the minimum scopes.

pub mod eventsub;
pub mod irc;
#[cfg(feature = "net")]
pub mod live;
pub mod oauth;
