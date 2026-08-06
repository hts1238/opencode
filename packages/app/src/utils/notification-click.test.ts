import { describe, expect, test } from "bun:test"
import { handleNotificationClick, NOTIFICATION_OPEN_EVENT } from "./notification-click"

describe("notification click", () => {
  test("emits notification-open event with href", () => {
    const calls: Array<string | undefined> = []
    const handler = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail : undefined
      calls.push(detail?.href)
    }
    window.addEventListener(NOTIFICATION_OPEN_EVENT, handler)
    handleNotificationClick("/abc/session/123")
    window.removeEventListener(NOTIFICATION_OPEN_EVENT, handler)
    expect(calls).toEqual(["/abc/session/123"])
  })

  test("emits notification-open event without href", () => {
    const calls: Array<string | undefined> = []
    const handler = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail : undefined
      calls.push(detail?.href)
    }
    window.addEventListener(NOTIFICATION_OPEN_EVENT, handler)
    handleNotificationClick()
    window.removeEventListener(NOTIFICATION_OPEN_EVENT, handler)
    expect(calls).toEqual([undefined])
  })
})
