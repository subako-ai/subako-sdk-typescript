# The chat example

A chat with a Subako agent, and nothing else: the smallest page the packages
make. `pnpm example chat` from the repo root brings it up on
<http://localhost:5173>.

```
server.mjs   names the agent this example publishes; the rest is ../shared/server.mjs
index.html   the Vite entry
src/
  main.tsx   creates the session, then mounts the provider and the page under StrictMode
  chat.tsx   the page: a title, and <SubakoChat> over the session
  chat.css   the layout around the chat; the chat brings its own styles
```

## Where each layer is used

| Layer                                 | Where                                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `SubakoClient` (api key)              | `server.mjs`, through `../shared/server.mjs`: creates sessions, mints tokens, publishes the agent |
| `SubakoSessionClient` (session token) | `src/main.tsx`, built once outside React and handed to `SubakoProvider`                           |
| `useSession`                          | `src/chat.tsx`, once                                                                              |
| `SubakoChat`                          | `src/chat.tsx`, filling the page below the title                                                  |

There are no tools: the agent only talks. The reply is drawn as markdown, which
is `<SubakoChat>`'s default. The page's own CSS is the layout around the chat
and the colors of the page; the chat's eight custom properties are left at
their defaults, so it follows the OS color scheme by itself.
