// Native rendering uses frozen or explicitly imported font data. Do not let
// canvas automatically enumerate system or per-user font directories.
process.env.DISABLE_SYSTEM_FONTS_LOAD = '1';
