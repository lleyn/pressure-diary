# Дневник давления — Android

Автономное приложение для Android 8.0 и новее (minSdk 26, targetSdk 36).
HTML, CSS и JavaScript находятся в `app/src/main/assets/`; входной файл — `index.html`.
Приложение использует системный Android WebView и сохраняет записи локально.
Разрешения интернета и доступа к общему хранилищу не запрашиваются. Резервное копирование отключено.

## Сборка без сети

Установите JDK 17 и Android SDK Platform 36 / Build Tools 36.0.0. В PowerShell:

```powershell
./build-debug.ps1 -SdkPath 'C:/Users/your-name/AppData/Local/Android/Sdk'
```

Если `javac` отсутствует в PATH, передайте также `-JdkPath 'C:/Program Files/Java/jdk-17'`.
Скрипт использует официальные SDK-инструменты: aapt2, javac, d8, zipalign и apksigner.
Результат: `app/build/outputs/apk/debug/app-debug.apk`. Подпись и выравнивание проверяются после сборки.
Для последующих обновлений APK сохраняйте `.tooling/debug.keystore`; это локальный отладочный ключ.

## Android Studio / Gradle

Откройте каталог `android` в Android Studio. Требуются Gradle 9.1.0, Android Gradle Plugin 9.0.1
и JDK 17 или новее. При первой Gradle-сборке нужен доступ к Google Maven и Maven Central.
`local.properties` с `sdk.dir=...` создаётся локально и не включается в исходники.

## Нативные функции

`Android.saveCsv(csv)` открывает системный выбор места сохранения CSV. UTF-8 BOM добавляется,
если его нет. Системные панели используют единственное светлое оформление «Ясность».
Внешние URL и ресурсы заблокированы, JS bridge доступен только упакованному содержимому.
Системная кнопка / жест «Назад» сначала вызывает `window.pressureBack()`; возврат `true`
означает, что интерфейс обработал действие, `false` завершает Activity.
