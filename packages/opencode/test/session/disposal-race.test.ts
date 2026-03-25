import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID } from "../../src/session/schema"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

describe("disposal race condition", () => {
  // Reproduces the Windows e2e flake where the session processor emits
  // PartUpdated events after the session has been deleted during disposal.
  //
  // The sequence in production:
  //   1. Instance.dispose() fires → Session.remove() deletes the session
  //   2. CASCADE deletes all message and part rows
  //   3. Session processor (still in flight) calls Session.updatePart()
  //   4. Projector INSERT hits FK constraint — message_id no longer exists
  //   5. SQLiteError: FOREIGN KEY constraint failed
  //
  // The fix should make late writes after deletion a no-op, not a crash.

  test.todo("late part update after session removal should not throw", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const messageID = MessageID.ascending()

        await Session.updateMessage({
          id: messageID,
          sessionID: session.id,
          role: "user",
          time: { created: Date.now(), updated: Date.now() },
          agent: "user",
          model: { providerID: "test", modelID: "test" },
          tools: {},
          mode: "",
        } as unknown as MessageV2.Info)

        await Session.updatePart({
          id: PartID.ascending(),
          messageID,
          sessionID: session.id,
          type: "text",
          text: "before removal",
        })

        // Delete session — cascades to messages and parts
        await Session.remove(session.id)

        // Late write from session processor — should be a no-op, not a crash
        await Session.updatePart({
          id: PartID.ascending(),
          messageID,
          sessionID: session.id,
          type: "text",
          text: "late arrival after disposal",
        })
      },
    })
  })
})
