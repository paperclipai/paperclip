import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "@/lib/router";
import { authApi, type SignWithEmailResult } from "../api/auth";
import { healthApi } from "../api/health";
import { CloudSignIn } from "@/components/CloudSignIn";
import { clearCloudSignInAttempt } from "@/lib/cloud-sign-in";
import { tenantSignInReturnPath } from "@/lib/cloudLinks";