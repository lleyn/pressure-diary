package ru.pressurediary.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
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
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/** Offline host for the packaged diary. Only local assets can reach its narrow CSV bridge. */
public final class MainActivity extends Activity {
    private static final String ASSET_ORIGIN = "file:///android_asset/";
    private static final int CREATE_CSV = 10;
    private FrameLayout root;
    private WebView webView;
    private String pendingCsv;

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
        webView.evaluateJavascript("(function(){try{return typeof window.pressureBack === 'function' && window.pressureBack() === true;}catch(e){return false;}})()",
                consumed -> { if (!"true".equals(consumed)) finish(); });
    }

    @Override public void onBackPressed() {
        handleBack();
    }

    public final class DiaryBridge {
        @JavascriptInterface public void saveCsv(String csv) {
            if (csv == null || csv.length() > 4 * 1024 * 1024) return;
            runOnUiThread(() -> {
                if (pendingCsv != null) return;
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

    @Override protected void onDestroy() {
        if (webView != null) {
            webView.removeJavascriptInterface("Android");
            webView.destroy();
        }
        super.onDestroy();
    }
}
