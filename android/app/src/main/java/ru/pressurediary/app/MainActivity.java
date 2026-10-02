package ru.pressurediary.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;
import android.window.OnBackInvokedDispatcher;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import org.json.JSONException;
import org.json.JSONObject;

/** Offline host for the packaged diary. Only local assets can reach its narrow CSV bridge. */
public final class MainActivity extends Activity {
    private static final String ASSET_ORIGIN = "file:///android_asset/";
    private static final int CREATE_CSV = 10;
    private static final int OPEN_CSV = 11;
    private static final int MAX_IMPORT_BYTES = 1024 * 1024;
    private final ExecutorService csvReader = Executors.newSingleThreadExecutor();
    private final Object importStreamLock = new Object();
    private FrameLayout root;
    private WebView webView;
    private String pendingCsv;
    private String activeImportRequestId;
    private Future<?> csvReadTask;
    private InputStream activeImportStream;
    private volatile boolean activityDestroyed;

    @SuppressLint("SetJavaScriptEnabled")
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        root = new FrameLayout(this);
        webView = new WebView(this);
        root.addView(webView, new FrameLayout.LayoutParams(-1, -1));
        setContentView(root);

        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            root.setOnApplyWindowInsetsListener((view, insets) -> {
                android.graphics.Insets safe = insets.getInsets(
                        WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout()
                                | WindowInsets.Type.ime());
                view.setPadding(safe.left, safe.top, safe.right, safe.bottom);
                return insets;
            });
        }
        applyLightSystemBars();

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSupportMultipleWindows(false);
        settings.setBuiltInZoomControls(false);
        settings.setTextZoom(100);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        webView.addJavascriptInterface(new DiaryBridge(), "Android");
        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !isLocalAsset(request.getUrl());
            }

            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                if (isLocalAsset(request.getUrl())) return null;
                return new WebResourceResponse("text/plain", "UTF-8", 403, "Blocked",
                        null, new ByteArrayInputStream(new byte[0]));
            }
        });
        webView.loadUrl(ASSET_ORIGIN + "index.html");
        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::handleBack);
        }
    }

    private static boolean isLocalAsset(Uri uri) {
        return "file".equals(uri.getScheme()) && uri.toString().startsWith(ASSET_ORIGIN);
    }

    private void applyLightSystemBars() {
        int color = Color.parseColor("#F4F7F4");
        root.setBackgroundColor(color);
        webView.setBackgroundColor(color);
        getWindow().setStatusBarColor(color);
        getWindow().setNavigationBarColor(color);
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) {
                int flags = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                        | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                controller.setSystemBarsAppearance(flags, flags);
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        }
    }

    private void handleBack() {
        if (activityDestroyed || webView == null) return;
        webView.evaluateJavascript("(function(){try{return typeof window.pressureBack === 'function' && window.pressureBack() === true;}catch(e){return false;}})()",
                consumed -> { if (!"true".equals(consumed)) finish(); });
    }

    @Override public void onBackPressed() {
        handleBack();
    }

    public final class DiaryBridge {
        @JavascriptInterface public void importCsv(String requestId) {
            if (requestId == null || requestId.isEmpty() || requestId.length() > 64) return;
            runOnUiThread(() -> {
                if (activityDestroyed || isFinishing()) return;
                if (activeImportRequestId != null || pendingCsv != null) {
                    deliverImportResult(requestId, null, null,
                            "Дождитесь завершения выбора другого файла.", false);
                    return;
                }
                activeImportRequestId = requestId;
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                try {
                    startActivityForResult(intent, OPEN_CSV);
                } catch (RuntimeException error) {
                    finishImport(requestId, null, null,
                            "Не удалось открыть выбор файла.", false);
                }
            });
        }

        @JavascriptInterface public void saveCsv(String csv) {
            if (csv == null || csv.length() > 4 * 1024 * 1024) return;
            runOnUiThread(() -> {
                if (activityDestroyed || isFinishing() || pendingCsv != null) return;
                if (activeImportRequestId != null) {
                    Toast.makeText(MainActivity.this, "Дождитесь завершения импорта", Toast.LENGTH_SHORT).show();
                    return;
                }
                pendingCsv = csv;
                Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("text/csv");
                intent.putExtra(Intent.EXTRA_TITLE, "дневник-давления.csv");
                try {
                    startActivityForResult(intent, CREATE_CSV);
                } catch (RuntimeException error) {
                    pendingCsv = null;
                    Toast.makeText(MainActivity.this, "Не удалось открыть сохранение файла", Toast.LENGTH_LONG).show();
                }
            });
        }
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (activityDestroyed) return;
        if (requestCode == OPEN_CSV) {
            String requestId = activeImportRequestId;
            if (requestId == null) return;
            if (resultCode != RESULT_OK) {
                finishImport(requestId, null, null, null, true);
            } else if (data == null || data.getData() == null
                    || !"content".equals(data.getData().getScheme())) {
                finishImport(requestId, null, null,
                        "Не удалось открыть выбранный файл. Выберите CSV ещё раз.", false);
            } else {
                Uri uri = data.getData();
                csvReadTask = csvReader.submit(() -> readImportedCsv(uri, requestId));
            }
            return;
        }
        if (requestCode != CREATE_CSV) return;
        String csv = pendingCsv;
        pendingCsv = null;
        if (resultCode != RESULT_OK || data == null || data.getData() == null || csv == null) return;
        try (OutputStream output = getContentResolver().openOutputStream(data.getData(), "wt")) {
            if (output == null) throw new java.io.IOException("No output stream");
            if (!csv.startsWith("\uFEFF")) output.write("\uFEFF".getBytes(StandardCharsets.UTF_8));
            output.write(csv.getBytes(StandardCharsets.UTF_8));
            Toast.makeText(this, "CSV сохранён", Toast.LENGTH_SHORT).show();
        } catch (Exception error) {
            Toast.makeText(this, "Не удалось сохранить CSV", Toast.LENGTH_LONG).show();
        }
    }

    private void readImportedCsv(Uri uri, String requestId) {
        try {
            String filename = importFilename(uri);
            if (activityDestroyed || Thread.currentThread().isInterrupted()) return;
            try (InputStream input = getContentResolver().openInputStream(uri)) {
                if (input == null) throw new IOException("Missing input stream");
                synchronized (importStreamLock) {
                    if (activityDestroyed) return;
                    activeImportStream = input;
                }
                try {
                    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                    byte[] chunk = new byte[8192];
                    int count;
                    while ((count = input.read(chunk)) != -1) {
                        if (activityDestroyed || Thread.currentThread().isInterrupted()) return;
                        if (bytes.size() > MAX_IMPORT_BYTES - count) {
                            finishImport(requestId, null, null,
                                    "Файл слишком большой. Максимальный размер — 1 МиБ.", false);
                            return;
                        }
                        for (int index = 0; index < count; index++) {
                            if (chunk[index] == 0) {
                                finishImport(requestId, null, null,
                                        "Файл не является текстовым CSV в UTF-8. Сохраните его в UTF-8.", false);
                                return;
                            }
                        }
                        bytes.write(chunk, 0, count);
                    }
                    byte[] content = bytes.toByteArray();
                    int offset = content.length >= 3 && (content[0] & 0xff) == 0xef
                            && (content[1] & 0xff) == 0xbb && (content[2] & 0xff) == 0xbf ? 3 : 0;
                    String csv = StandardCharsets.UTF_8.newDecoder()
                            .onMalformedInput(CodingErrorAction.REPORT)
                            .onUnmappableCharacter(CodingErrorAction.REPORT)
                            .decode(ByteBuffer.wrap(content, offset, content.length - offset)).toString();
                    finishImport(requestId, csv, filename, null, false);
                } finally {
                    synchronized (importStreamLock) {
                        if (activeImportStream == input) activeImportStream = null;
                    }
                }
            }
        } catch (CharacterCodingException error) {
            finishImport(requestId, null, null,
                    "Не удалось прочитать кодировку файла. Сохраните CSV в UTF-8.", false);
        } catch (SecurityException error) {
            finishImport(requestId, null, null,
                    "Нет доступа к выбранному файлу. Выберите его ещё раз.", false);
        } catch (IOException | RuntimeException error) {
            finishImport(requestId, null, null,
                    "Не удалось прочитать файл. Проверьте, что он доступен, и попробуйте ещё раз.", false);
        }
    }

    private String importFilename(Uri uri) {
        try (Cursor cursor = getContentResolver().query(uri,
                new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int column = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (column >= 0) {
                    String name = cursor.getString(column);
                    if (name != null && !name.trim().isEmpty()) {
                        return name.length() <= 240 ? name : name.substring(0, 240);
                    }
                }
            }
        } catch (RuntimeException ignored) {
            // Some document providers do not expose a display name.
        }
        return "выбранный файл.csv";
    }

    private void finishImport(String requestId, String text, String filename,
                              String error, boolean cancelled) {
        runOnUiThread(() -> {
            if (activityDestroyed || !requestId.equals(activeImportRequestId)) return;
            activeImportRequestId = null;
            csvReadTask = null;
            deliverImportResult(requestId, text, filename, error, cancelled);
        });
    }

    /** Called only on the main thread. All document input is encoded as JSON data. */
    private void deliverImportResult(String requestId, String text, String filename,
                                     String error, boolean cancelled) {
        if (activityDestroyed || isFinishing() || webView == null) return;
        JSONObject result = new JSONObject();
        try {
            result.put("requestId", requestId);
            if (cancelled) {
                result.put("cancelled", true);
            } else if (error != null) {
                result.put("error", error);
            } else {
                result.put("text", text);
                result.put("name", filename);
            }
        } catch (JSONException impossible) {
            return;
        }
        String json = result.toString().replace("\u2028", "\\u2028").replace("\u2029", "\\u2029");
        webView.evaluateJavascript("(function(data){if(typeof window.pressureReceiveCsv==='function'){window.pressureReceiveCsv(data);}})("
                + json + ");", null);
    }

    @Override protected void onDestroy() {
        activityDestroyed = true;
        activeImportRequestId = null;
        if (csvReadTask != null) csvReadTask.cancel(true);
        csvReader.shutdownNow();
        InputStream stream;
        synchronized (importStreamLock) {
            stream = activeImportStream;
            activeImportStream = null;
        }
        if (stream != null) {
            try { stream.close(); } catch (IOException ignored) { }
        }
        if (webView != null) {
            webView.removeJavascriptInterface("Android");
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
