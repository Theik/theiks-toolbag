export const TOOLBAG_TAB_ID = "theiks-toolbag";

const TAB_GROUP = "sheet";
const PANEL_CLASS = "theiks-toolbag-config-tab";
const CONTROL_CLASS = "theiks-toolbag-tab-control";
const GENERATED_NAV_CLASS = "theiks-toolbag-generated-tabs";
const NATIVE_PANEL_CLASS = "theiks-toolbag-native-tab";

/**
 * Mount one Toolbag configuration tab into a native tabbed sheet or create a two-tab layout.
 *
 * Foundry's normal Light and Tile sheets already provide a `sheet` tab group. WallConfig and
 * all three Placeable Palettes do not, so those forms are progressively enhanced in-place.
 *
 * @param {{
 *   application: foundry.applications.api.ApplicationV2,
 *   element: HTMLElement,
 *   content: string,
 *   feature: string,
 *   nativeTab?: string,
 *   nativeLabel: string,
 *   nativeIcon: string
 * }} options
 * @returns {{panel: HTMLElement, root: HTMLElement}|null}
 */
export function mountToolbagConfigTab({
  application,
  element,
  content,
  feature,
  nativeTab,
  nativeLabel,
  nativeIcon
}) {
  const existing = element.querySelector(`.${PANEL_CLASS}[data-toolbag-feature="${feature}"]`);
  if (existing) return {panel: existing, root: getFormRoot(application, element)};

  const root = getFormRoot(application, element);
  if (!root) return null;

  let navigation = element.querySelector("nav.sheet-tabs");
  let nativePanel = nativeTab
    ? element.querySelector(`.tab[data-tab="${nativeTab}"]`)
    : null;

  if (!navigation || !nativePanel) {
    navigation = createNavigation(feature);
    nativePanel = root;
    prepareNativePanel(nativePanel, feature);
    nativePanel.before(navigation);
    navigation.append(createTabControl({
      feature,
      tab: nativePanel.dataset.tab,
      label: nativeLabel,
      icon: nativeIcon,
      active: true
    }));
  }

  const group = navigation.querySelector("[data-group]")?.dataset.group
    ?? nativePanel.dataset.group
    ?? TAB_GROUP;
  const toolbagLabel = localize("THEIKS_TOOLBAG.ConfigTabs.Toolbag");
  const control = createTabControl({
    feature,
    tab: TOOLBAG_TAB_ID,
    label: toolbagLabel,
    icon: "fa-solid fa-toolbox",
    group
  });
  navigation.append(control);

  const panel = globalThis.document.createElement("section");
  panel.className = `tab standard-form scrollable ${PANEL_CLASS}`;
  panel.dataset.group = group;
  panel.dataset.tab = TOOLBAG_TAB_ID;
  panel.dataset.toolbagFeature = feature;
  panel.insertAdjacentHTML("beforeend", content);

  const parent = nativePanel.parentElement;
  const footer = parent?.querySelector(":scope > footer, :scope > .form-footer");
  if (footer) parent.insertBefore(panel, footer);
  else parent?.append(panel);

  if (application.tabGroups?.[group] === TOOLBAG_TAB_ID) {
    activateTab(element, group, TOOLBAG_TAB_ID);
  }

  return {panel, root};
}

/** Remove Toolbag tabs for a disabled feature and restore generated native form layouts. */
export function removeToolbagConfigTabs(feature, ownerDocument = globalThis.document) {
  const panels = ownerDocument?.querySelectorAll?.(
    `.${PANEL_CLASS}[data-toolbag-feature="${feature}"]`
  ) ?? [];

  for (const panel of panels) {
    if (!panel?.dataset) {
      panel?.remove?.();
      continue;
    }
    const scope = panel.closest?.("form") ?? panel.parentElement;
    const group = panel.dataset.group ?? TAB_GROUP;
    const wasActive = panel.classList.contains("active");
    const control = scope?.querySelector?.(
      `.${CONTROL_CLASS}[data-toolbag-feature="${feature}"][data-tab="${TOOLBAG_TAB_ID}"]`
    );
    const generatedNavigation = scope?.querySelector?.(
      `.${GENERATED_NAV_CLASS}[data-toolbag-feature="${feature}"]`
    );
    const nativePanel = scope?.querySelector?.(
      `.${NATIVE_PANEL_CLASS}[data-toolbag-feature="${feature}"]`
    );

    panel.remove();
    control?.remove();

    if (generatedNavigation && nativePanel) {
      generatedNavigation.remove();
      restoreNativePanel(nativePanel);
      continue;
    }

    if (wasActive) {
      const replacement = scope?.querySelector?.(
        `nav.sheet-tabs [data-action="tab"][data-group="${group}"]:not(.${CONTROL_CLASS})`
      );
      if (replacement?.dataset.tab) activateTab(scope, group, replacement.dataset.tab);
    }
  }
}

function getFormRoot(application, element) {
  return element.querySelector(".standard-form.scrollable")
    ?? application.form
    ?? element.querySelector("form");
}

function createNavigation(feature) {
  const navigation = globalThis.document.createElement("nav");
  navigation.className = `sheet-tabs tabs top-tabs ${GENERATED_NAV_CLASS}`;
  navigation.dataset.toolbagFeature = feature;
  navigation.setAttribute("aria-roledescription", localize("SHEETS.FormNavLabel"));
  return navigation;
}

function prepareNativePanel(panel, feature) {
  panel.classList.add("tab", "active", NATIVE_PANEL_CLASS);
  panel.dataset.group = TAB_GROUP;
  panel.dataset.tab = `theiks-toolbag-native-${feature}`;
  panel.dataset.toolbagFeature = feature;
}

function restoreNativePanel(panel) {
  panel.classList.remove("tab", "active", NATIVE_PANEL_CLASS);
  delete panel.dataset.group;
  delete panel.dataset.tab;
  delete panel.dataset.toolbagFeature;
}

function createTabControl({feature, tab, label, icon, group = TAB_GROUP, active = false}) {
  const control = globalThis.document.createElement("a");
  control.className = `${CONTROL_CLASS}${active ? " active" : ""}`;
  control.dataset.action = "tab";
  control.dataset.group = group;
  control.dataset.tab = tab;
  control.dataset.toolbagFeature = feature;

  const iconElement = globalThis.document.createElement("i");
  iconElement.className = icon;
  iconElement.setAttribute("inert", "");
  control.append(iconElement);

  const labelElement = globalThis.document.createElement("span");
  labelElement.textContent = label;
  control.append(labelElement);
  return control;
}

function activateTab(scope, group, tab) {
  scope?.querySelectorAll?.(`[data-group="${group}"][data-tab]`).forEach(element => {
    element.classList.toggle("active", element.dataset.tab === tab);
  });
}

function localize(key) {
  return globalThis.game?.i18n?.localize?.(key) ?? key;
}
