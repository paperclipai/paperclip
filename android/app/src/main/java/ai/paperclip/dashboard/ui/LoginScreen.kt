package ai.paperclip.dashboard.ui

import androidx.compose.foundation.layout.Arrangement
import ai.paperclip.dashboard.parseBoardClaimUrl
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.material3.Switch
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp

private val AUTH_MODES = listOf("Email", "Board key", "Local")

@Composable
fun LoginScreen(
    initialUrl: String,
    busy: Boolean,
    error: String?,
    onScanned: (String) -> Unit,
    onSubmit: (url: String, email: String, password: String, boardKey: String, signUpName: String?, claimUrl: String) -> Unit,
) {
    var url by rememberSaveable { mutableStateOf(initialUrl.ifBlank { "http://" }) }
    var mode by rememberSaveable { mutableIntStateOf(0) }
    var email by rememberSaveable { mutableStateOf("") }
    // Secrets use plain remember so they never land in the saved-instance Bundle.
    var password by remember { mutableStateOf("") }
    var boardKey by remember { mutableStateOf("") }
    var createAccount by rememberSaveable { mutableStateOf(false) }
    var name by rememberSaveable { mutableStateOf("") }
    var claimUrl by rememberSaveable { mutableStateOf("") }
    var scanError by remember { mutableStateOf<String?>(null) }
    val context = LocalContext.current

    Column(
        Modifier.fillMaxSize().safeDrawingPadding().imePadding().verticalScroll(rememberScrollState()).padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("Paperclip", style = MaterialTheme.typography.displaySmall)
        Button(
            onClick = {
                scanError = null
                val options = GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()
                GmsBarcodeScanning.getClient(context, options).startScan()
                    .addOnSuccessListener { barcode -> barcode.rawValue?.let(onScanned) }
                    .addOnFailureListener { e -> scanError = "Scanner unavailable: ${e.message}" }
            },
            enabled = !busy,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Icon(Icons.Default.QrCodeScanner, null)
            Text("Scan QR code", Modifier.padding(start = 8.dp))
        }
        Text(
            "On the web dashboard open Profile → Mobile app → Pair a phone, then scan the code.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        scanError?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
        HorizontalDivider()
        Text(
            "Connect to your Paperclip instance",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        OutlinedTextField(
            value = url,
            onValueChange = { url = it },
            label = { Text("Server URL") },
            placeholder = { Text("http://192.168.1.10:3100") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
            modifier = Modifier.fillMaxWidth(),
        )
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
            AUTH_MODES.forEachIndexed { i, label ->
                SegmentedButton(
                    selected = mode == i,
                    onClick = { mode = i },
                    shape = SegmentedButtonDefaults.itemShape(i, AUTH_MODES.size),
                ) { Text(label) }
            }
        }
        when (mode) {
            0 -> {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text("Create a new account", Modifier.weight(1f))
                    Switch(checked = createAccount, onCheckedChange = { createAccount = it })
                }
                if (createAccount) {
                    OutlinedTextField(
                        value = name,
                        onValueChange = { name = it },
                        label = { Text("Name") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                OutlinedTextField(
                    value = email,
                    onValueChange = { email = it },
                    label = { Text("Email") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = password,
                    onValueChange = { password = it },
                    label = { Text("Password") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = claimUrl,
                    onValueChange = { claimUrl = it },
                    label = { Text("Board claim URL (optional)") },
                    supportingText = {
                        Text("First startup only: paste the one-time URL printed under \"BOARD CLAIM REQUIRED\" in the server log to become the instance owner.")
                    },
                    isError = claimUrl.isNotBlank() && parseBoardClaimUrl(claimUrl) == null,
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            1 -> OutlinedTextField(
                value = boardKey,
                onValueChange = { boardKey = it },
                label = { Text("Board API key") },
                supportingText = { Text("Create one with `paperclipai auth login` or in instance settings") },
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                modifier = Modifier.fillMaxWidth(),
            )
            else -> Text(
                "For instances running in local_trusted mode (no sign-in required).",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Button(
            onClick = {
                onSubmit(
                    url,
                    if (mode == 0) email else "",
                    if (mode == 0) password else "",
                    if (mode == 1) boardKey else "",
                    if (mode == 0 && createAccount) name.ifBlank { email.substringBefore('@') } else null,
                    if (mode == 0) claimUrl else "",
                )
            },
            enabled = !busy && url.length > "http://".length &&
                (mode != 0 || (email.isNotBlank() && password.length >= if (createAccount) 8 else 1)) &&
                (mode != 1 || boardKey.isNotBlank()),
            modifier = Modifier.fillMaxWidth(),
        ) {
            if (busy) CircularProgressIndicator(Modifier.padding(2.dp), strokeWidth = 2.dp)
            else Text(if (mode == 0 && createAccount) "Create account" else "Connect")
        }
    }
}
