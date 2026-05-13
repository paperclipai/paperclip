import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Populate a PVC with a fixture directory by spinning a one-shot Pod that
 * `git init && cp -r /fixtures/* . && git add . && git commit`. The fixture
 * is delivered to the Pod via a ConfigMap (small repos only — KB scale).
 */
export async function seedWorkspaceFromFixture(input: {
  kubeconfigPath: string;
  namespace: string;
  pvcName: string;
  fixtureDir: string;          // local path to copy
  podName?: string;
}): Promise<void> {
  const podName = input.podName ?? "seed-workspace";

  // 1. Pack the fixture into a ConfigMap. ConfigMaps support up to 1Mi.
  const tmp = mkdtempSync(join(tmpdir(), "paperclip-fixture-"));
  const archive = join(tmp, "fixture.tar.gz");
  execSync(`tar -czf ${archive} -C ${input.fixtureDir} .`, { stdio: "inherit" });
  execSync(
    `kubectl --kubeconfig ${input.kubeconfigPath} -n ${input.namespace} create configmap fixture-tar --from-file=fixture.tar.gz=${archive} --dry-run=client -o yaml | kubectl --kubeconfig ${input.kubeconfigPath} apply -f -`,
    { stdio: "inherit" },
  );

  // 2. Run a one-shot Pod that unpacks the tar into the PVC + git inits.
  const podYaml = `
apiVersion: v1
kind: Pod
metadata:
  name: ${podName}
  namespace: ${input.namespace}
spec:
  restartPolicy: Never
  containers:
    - name: seed
      image: alpine/git:2.45.0
      command: ["sh", "-euxc"]
      args:
        - |
          mkdir -p /workspace
          cd /workspace
          tar -xzf /fixture/fixture.tar.gz
          git init -b main
          git -c user.email=seed@local -c user.name=seed add .
          git -c user.email=seed@local -c user.name=seed commit -m "init"
      volumeMounts:
        - name: workspace
          mountPath: /workspace
        - name: fixture
          mountPath: /fixture
  volumes:
    - name: workspace
      persistentVolumeClaim:
        claimName: ${input.pvcName}
    - name: fixture
      configMap:
        name: fixture-tar
`;
  const yamlFile = join(tmp, "pod.yaml");
  writeFileSync(yamlFile, podYaml);
  execSync(`kubectl --kubeconfig ${input.kubeconfigPath} apply -f ${yamlFile}`, { stdio: "inherit" });
  execSync(
    `kubectl --kubeconfig ${input.kubeconfigPath} wait --for=condition=Ready=false --for=jsonpath='{.status.phase}'=Succeeded pod/${podName} -n ${input.namespace} --timeout=120s`,
    { stdio: "inherit" },
  );
}
