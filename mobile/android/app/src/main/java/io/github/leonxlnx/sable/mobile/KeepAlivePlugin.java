package io.github.leonxlnx.sable.mobile;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** The page's switch for KeepAliveService: armed with a line while a chat runs or waits, disarmed (null) when none does. */
@CapacitorPlugin(name = "KeepAlive")
public class KeepAlivePlugin extends Plugin {
    @PluginMethod
    public void arm(PluginCall call) {
        String text = call.getString("text");
        KeepAliveService.armed = text;
        if (text == null) KeepAliveService.stop(getContext());
        call.resolve();
    }
}
