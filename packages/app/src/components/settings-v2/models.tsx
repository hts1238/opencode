import { useFilteredList } from "@opencode-ai/ui/hooks"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { createMemo, type Component, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { type ModelKey, useModels } from "@/context/models"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { popularProviders, useProviders } from "@/hooks/use-providers"
import { showToast } from "@/utils/toast"
import { Persist, persisted } from "@/utils/persist"
import { ModelSelectorPopoverV2 } from "../dialog-select-model"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

type ModelItem = ReturnType<ReturnType<typeof useModels>["list"]>[number]

const PROVIDER_ICON_SIZE = 16

function parseConfigModel(value: string | undefined) {
  if (!value) return
  const [providerID, ...rest] = value.split("/")
  const modelID = rest.join("/")
  if (!providerID || !modelID) return
  return { providerID, modelID }
}

export const SettingsModelsV2: Component = () => {
  const language = useLanguage()
  const models = useModels()
  const serverSdk = useServerSDK()
  const serverSync = useServerSync()
  const providers = useProviders(() => undefined)
  const [store, setStore] = persisted(
    Persist.serverGlobal(serverSdk().scope, "settings-v2.models.providers"),
    createStore({ collapsed: {} as Record<string, boolean> }),
  )

  const configuredDefaultModel = createMemo(() => {
    const model = parseConfigModel(serverSync().data.config.model)
    if (!model) return
    return models.find(model)
  })

  const currentDefaultModel = createMemo(() => {
    const configured = configuredDefaultModel()
    if (configured) return configured

    const defaults = providers.default()
    for (const provider of providers.connected()) {
      const configuredModel = defaults[provider.id]
      const found = configuredModel ? models.find({ providerID: provider.id, modelID: configuredModel }) : undefined
      if (found) return found

      const first = Object.values(provider.models)[0]
      if (!first) continue
      const fallback = models.find({ providerID: provider.id, modelID: first.id })
      if (fallback) return fallback
    }
  })

  const setDefaultModel = (model: ModelKey | undefined, options?: { recent?: boolean }) => {
    if (!model) return
    const before = serverSync().data.config.model
    const next = `${model.providerID}/${model.modelID}`
    serverSync().set("config", "model", next)
    models.setVisibility(model, true)
    if (options?.recent) models.recent.push(model)
    void serverSync()
      .updateConfig({ model: next })
      .catch((err: unknown) => {
        serverSync().set("config", "model", before)
        showToast({
          title: language.t("common.requestFailed"),
          description: err instanceof Error ? err.message : String(err),
        })
      })
  }

  const defaultModelState = {
    current: currentDefaultModel,
    list: models.list,
    set: setDefaultModel,
    visible: models.visible,
  }

  const list = useFilteredList<ModelItem>({
    items: (_filter) => models.list(),
    key: (x) => `${x.provider.id}:${x.id}`,
    filterKeys: ["provider.name", "name", "id"],
    sortBy: (a, b) => a.name.localeCompare(b.name),
    groupBy: (x) => x.provider.id,
    sortGroupsBy: (a, b) => {
      const aIndex = popularProviders.indexOf(a.category)
      const bIndex = popularProviders.indexOf(b.category)
      const aPopular = aIndex >= 0
      const bPopular = bIndex >= 0

      if (aPopular && !bPopular) return -1
      if (!aPopular && bPopular) return 1
      if (aPopular && bPopular) return aIndex - bIndex

      const aName = a.items[0].provider.name
      const bName = b.items[0].provider.name
      return aName.localeCompare(bName)
    },
  })

  return (
    <>
      <div class="settings-v2-tab-header settings-v2-tab-header--stacked">
        <h2 class="settings-v2-tab-title">{language.t("settings.models.title")}</h2>
        <div class="settings-v2-tab-search">
          <TextInputV2
            type="search"
            appearance="base"
            value={list.filter()}
            onInput={(event) => list.onInput(event.currentTarget.value)}
            placeholder={language.t("dialog.model.search.placeholder")}
            spellcheck={false}
            autocorrect="off"
            autocomplete="off"
            autocapitalize="off"
            aria-label={language.t("dialog.model.search.placeholder")}
          />
          <Show when={list.filter()}>
            <IconButtonV2
              type="button"
              variant="ghost-muted"
              size="small"
              class="settings-v2-tab-search-clear"
              icon={<IconV2 name="close" size="large" class="text-v2-icon-icon-muted" />}
              onClick={() => list.clear()}
            />
          </Show>
        </div>
      </div>

      <div class="settings-v2-tab-body settings-v2-models">
        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.models.section.defaults")}</h3>
          <SettingsListV2>
            <SettingsRowV2
              title={language.t("settings.models.defaultModel.title")}
              description={language.t("settings.models.defaultModel.description")}
            >
              <ModelSelectorPopoverV2
                model={defaultModelState}
                trigger={(triggerProps) => (
                  <ButtonV2
                    {...triggerProps}
                    type="button"
                    variant="neutral"
                    size="normal"
                    class="group min-w-0 max-w-[260px]"
                    data-action="settings-default-model"
                  >
                    <Show when={currentDefaultModel()?.provider.id}>
                      <ProviderIcon
                        id={currentDefaultModel()?.provider.id ?? ""}
                        width={PROVIDER_ICON_SIZE}
                        height={PROVIDER_ICON_SIZE}
                        class="shrink-0 opacity-60 transition-opacity duration-150 group-hover:opacity-100"
                      />
                    </Show>
                    <span class="truncate">
                      {currentDefaultModel()?.name ?? language.t("settings.models.defaultModel.empty")}
                    </span>
                    <IconV2 name="chevron-down" size="small" class="shrink-0 text-v2-icon-icon-muted" />
                  </ButtonV2>
                )}
              />
            </SettingsRowV2>
          </SettingsListV2>
        </div>

        <Show
          when={!list.grouped.loading}
          fallback={
            <div class="settings-v2-models-status">
              {language.t("common.loading")}
              {language.t("common.loading.ellipsis")}
            </div>
          }
        >
          <Show
            when={list.flat().length > 0}
            fallback={
              <div class="settings-v2-models-status">
                <span>{language.t("dialog.model.empty")}</span>
                <Show when={list.filter()}>
                  <span class="settings-v2-models-status-filter">&quot;{list.filter()}&quot;</span>
                </Show>
              </div>
            }
          >
            <For each={list.grouped.latest}>
              {(group) => {
                const searching = () => list.filter().length > 0
                const expanded = () => searching() || !store.collapsed[group.category]

                return (
                  <div
                    class="settings-v2-section"
                    data-component="settings-models-provider"
                    data-expanded={expanded() ? "" : undefined}
                  >
                    <h3 class="settings-v2-models-group-header">
                      <button
                        type="button"
                        class="settings-v2-models-group-trigger"
                        aria-expanded={expanded()}
                        disabled={searching()}
                        onClick={() => setStore("collapsed", group.category, expanded())}
                      >
                        <span class="settings-v2-models-group-chevron">
                          <Show
                            when={expanded()}
                            fallback={
                              <svg width="5" height="6" viewBox="0 0 5 6" fill="none" aria-hidden="true">
                                <path
                                  d="M0.75194 5.31663C0.41861 5.51103 0 5.27063 0 4.88473V0.500754C0 0.114854 0.41861 -0.125577 0.75194 0.0688635L4.5096 2.26084C4.8404 2.45378 4.8404 2.93168 4.5096 3.12462L0.75194 5.31663Z"
                                  fill="currentColor"
                                />
                              </svg>
                            }
                          >
                            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                              <path
                                d="M5.37624 6.75194C5.18184 6.41861 5.42224 6 5.80814 6H10.1921C10.578 6 10.8184 6.41861 10.624 6.75194L8.43203 10.5096C8.23909 10.8404 7.76119 10.8404 7.56825 10.5096L5.37624 6.75194Z"
                                fill="currentColor"
                              />
                            </svg>
                          </Show>
                        </span>
                        <span class="settings-v2-models-group-label">
                          <ProviderIcon
                            id={group.category}
                            width={PROVIDER_ICON_SIZE}
                            height={PROVIDER_ICON_SIZE}
                            class="settings-v2-models-provider-icon shrink-0"
                          />
                          <span class="settings-v2-section-title">{group.items[0].provider.name}</span>
                        </span>
                      </button>
                    </h3>
                    <Show when={expanded()}>
                      <SettingsListV2>
                        <For each={group.items}>
                          {(item) => {
                            const key = { providerID: item.provider.id, modelID: item.id }
                            return (
                              <SettingsRowV2 title={item.name} description="">
                                <div>
                                  <Switch
                                    checked={models.visible(key)}
                                    onChange={(checked) => {
                                      models.setVisibility(key, checked)
                                    }}
                                    hideLabel
                                  >
                                    {item.name}
                                  </Switch>
                                </div>
                              </SettingsRowV2>
                            )
                          }}
                        </For>
                      </SettingsListV2>
                    </Show>
                  </div>
                )
              }}
            </For>
          </Show>
        </Show>
      </div>
    </>
  )
}
