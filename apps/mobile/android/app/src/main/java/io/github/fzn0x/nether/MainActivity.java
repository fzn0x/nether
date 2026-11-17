package io.github.fzn0x.nether;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;
import androidx.appcompat.app.AlertDialog;
import androidx.webkit.WebViewCompat;
import com.getcapacitor.BridgeActivity;

/**
 * Nether on Android (ADR 0087): the desktop app's page in the system's
 * WebView, with the app's own plugin for the vaults on the phone, and its
 * inbox for what the share sheet hands it.
 */
public class MainActivity extends BridgeActivity {

    /** The oldest Chromium the page's build runs in: Vite's default target, Chrome 111. */
    private static final int OLDEST_WEBVIEW = 111;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NetherVaultsPlugin.class);
        registerPlugin(NetherInboxPlugin.class);
        super.onCreate(savedInstanceState);
        // The perf build is measured through the WebView's DevTools (tools/perf/android.mjs).
        if ("perf".equals(BuildConfig.BUILD_TYPE)) WebView.setWebContentsDebuggingEnabled(true);
        // The debug build may sync with a development server over plain HTTP on
        // the emulator's host (ADR 0087): its socket is ws:, which the page's
        // own https: origin would otherwise refuse. Release builds speak only HTTPS.
        if (BuildConfig.DEBUG) {
            getBridge().getWebView().getSettings().setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }
        warnOfAnOldWebView();
    }

    /**
     * Android System WebView updates apart from the system: one older than
     * the page needs cannot run it, so the app asks for an update.
     */
    private void warnOfAnOldWebView() {
        PackageInfo webView = WebViewCompat.getCurrentWebViewPackage(this);
        if (webView == null || webView.versionName == null) return;
        int major;
        try {
            major = Integer.parseInt(webView.versionName.split("\\.")[0]);
        } catch (NumberFormatException e) {
            return;
        }
        if (major >= OLDEST_WEBVIEW) return;
        String store = webView.packageName;
        new AlertDialog.Builder(this)
            .setTitle(R.string.webview_old_title)
            .setMessage(getString(R.string.webview_old_message, OLDEST_WEBVIEW, major))
            .setPositiveButton(R.string.webview_update, (dialog, which) -> openStore(store))
            .setNegativeButton(R.string.webview_later, null)
            .show();
    }

    private void openStore(String app) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=" + app)));
        } catch (ActivityNotFoundException e) {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/apps/details?id=" + app)));
        }
    }
}
