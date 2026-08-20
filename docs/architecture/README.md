# AutoCut Studio architecture

AutoCut Studio 1.2 ships one CEP execution path. `js/main.js` contains the
production panel workflow and calls the named `AutoCutStudio` host functions
through `CSInterface.evalScript`. `jsx/host.jsx` is generated from the single
ES3-compatible ExtendScript implementation.

The analyzer and installer are Rust workspace crates. Native color processing
is a standalone C++ library linked by the Premiere effect and by its test
executable. Distributed beat selection is the only browser-side domain module;
marker ownership, timing conversion, the ten Scale movements, motion ownership,
and color-effect control remain in the Premiere host implementation.
