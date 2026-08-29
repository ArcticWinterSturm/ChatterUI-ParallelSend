# ChatterUI - A simple app for LLMs

ChatterUI is a native mobile frontend for LLMs.

Run LLMs on device or connect to various commercial or open source APIs. ChatterUI aims to provide a mobile-friendly interface with fine-grained control over chat structuring.

If you like the app, feel free support THE ORIGNAL AUTHOR Vali98

<a href='https://ko-fi.com/W7W7X8T7W' target='_blank'><img height='42' style='border:0px;height:42px;' src='https://storage.ko-fi.com/cdn/kofi6.png?v=6' border='0' alt='Buy Me a Coffee at ko-fi.com' /></a>

r4- chain has a working android APK with changes to templates, atomic database writes, disable camera + send on attach + context switch on attach. Basically allows you to hammer APIs with vision tasks (OCR, mapping, visual quality checking, photo edits and all that)

The r5-chain-capture branch proposes an experimental Android attachment/vision workflow developed against upstream commit 3cc78f9.

It is not currently a merge-ready representation of upstream dev; upstream has subsequently advanced. See the linked Discussion for implementation details, testing results, and the current upstream-port status.

## Development

### Android

To run a development build, follow these simple steps:

-   Install any Java 17/21 SDK of your choosing
-   Install `android-sdk` via `Android Studio`
-   Clone the repo:

```
git clone https://github.com/Vali-98/ChatterUI.git
```

-   Install dependencies via npm and run via Expo:

```
npm install
npx expo run:android
```

#### Building an APK

Requires Node.js, Java 17/21 SDK and Android SDK. Expo uses EAS to build apps which requires a Linux environment.

1. Clone the repo.
2. Rename the `eas.json.example` to `eas.json`.
3. Modify `"ANDROID_SDK_ROOT"` to the directory of your Android SDK
4. Run the following:

```
npm install
eas build --platform android --local
```

### IOS

Currently in development

## Acknowledgement

-   [llama.cpp](https://github.com/ggerganov/llama.cpp) - the underlying engine to run LLMs
-   [llama.rn](https://github.com/mybigday/llama.rn) - the original react-native llama.cpp adapter
