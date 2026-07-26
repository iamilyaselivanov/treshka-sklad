package com.treshka.sklad

import android.app.Application

/**
 * Owns the process-wide database helper. Activity and Firebase callbacks can
 * run concurrently; sharing one AppStateStore also shares its synchronization
 * monitor and prevents one caller pruning another caller's pending backup.
 */
class WarehouseApplication : Application() {
    val appStateStore: AppStateStore by lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
        AppStateStore(this)
    }
}
