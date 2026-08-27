/**
 * "Follow system" mode: registered by sw.js immediately before dark-inject.js,
 * which reads this and puts it on the <link>'s media attribute. Content scripts
 * in one registration share an isolated world and run in order.
 *
 * A one-line file rather than a second copy of the stylesheet - the media
 * attribute does the same job @media (prefers-color-scheme: dark) used to.
 */
var __ssextDarkMedia = "(prefers-color-scheme: dark)";
