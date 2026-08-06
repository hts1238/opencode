export const NOTIFICATION_OPEN_EVENT = "opencode:notification-open"
export const NOTIFICATION_PERMISSION_GRANTED_EVENT = "opencode:notification-permission-granted"
export const SERVICE_WORKER_NOTIFICATION_OPEN = "notification.open"

export type NotificationOpenDetail = {
  href?: string
}

export const handleNotificationClick = (href?: string) => {
  if (typeof window !== "object") return
  window.dispatchEvent(new CustomEvent<NotificationOpenDetail>(NOTIFICATION_OPEN_EVENT, { detail: { href } }))
  window.focus()
}
