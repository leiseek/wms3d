package com.wms3d.app.scanner;

/**
 * 纯逻辑缓冲（无 Android 依赖，可 JVM 单测）：累积可打印字符，遇 Enter/Tab 结束一帧；
 * 超过上限：进入"丢弃直到终止符"状态（R3）——整帧作废，不会把超长码的尾部当成新的一帧输出；
 * 遇终止符或空闲超时后恢复正常。超时由调用方用 {@link #flushIfIdle(long)} 触发（docs/04-mobile.md §2.1）。
 * ACTION_MULTIPLE 等在 M3 由 native/capacitor-scanner 处理。
 */
public final class ScanKeyBuffer {
    public static final int DEFAULT_MAX_LEN = 256;
    private final StringBuilder sb = new StringBuilder();
    private final int maxLen;
    private final long idleTimeoutMs;
    private long lastAtMs = -1;
    private boolean discarding = false;
    private int overflowCount = 0;

    public ScanKeyBuffer(int maxLen, long idleTimeoutMs) {
        this.maxLen = maxLen;
        this.idleTimeoutMs = idleTimeoutMs;
    }

    /** @return 完成的一帧（遇到终止符）或 null */
    public String onChar(char c, long nowMs) {
        lastAtMs = nowMs;
        if (c == '\n' || c == '\r' || c == '\t') {
            if (discarding) {
                discarding = false;
                return null;
            }
            return takeIfNotEmpty();
        }
        if (c < 0x20 || discarding) return null;
        if (sb.length() >= maxLen) {
            sb.setLength(0);
            discarding = true;
            overflowCount++;
            return null;
        }
        sb.append(c);
        return null;
    }

    /** 是否处于超长丢弃状态 */
    public boolean isDiscarding() {
        return discarding;
    }

    /** 累计超长次数（诊断页） */
    public int overflowCount() {
        return overflowCount;
    }

    /** 空闲兜底：距最后一个字符超过 idleTimeoutMs 时输出已缓冲内容 */
    public String flushIfIdle(long nowMs) {
        if (lastAtMs < 0 || nowMs - lastAtMs < idleTimeoutMs) return null;
        if (discarding) {
            discarding = false;
            sb.setLength(0);
            return null;
        }
        return takeIfNotEmpty();
    }

    private String takeIfNotEmpty() {
        if (sb.length() == 0) return null;
        String s = sb.toString();
        sb.setLength(0);
        return s;
    }
}
