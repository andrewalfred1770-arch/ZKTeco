; CheckIn installer branding (included by electron-builder via build.nsis.include).
; electron-builder's common.nsh sets BrandingText "${PRODUCT_NAME} ${VERSION}", which shows the numeric version at the bottom of the
; installer window. customHeader runs after common.nsh, so this later BrandingText wins. Internal version metadata (VIProductVersion,
; registry DisplayVersion, latest.yml) is NOT touched - only the visible label.
!macro customHeader
  BrandingText "${PRODUCT_NAME}"
!macroend
