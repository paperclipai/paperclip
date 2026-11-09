import { ciSmokeLabScenarios } from "./smoke-lab.catalog";
import { defineSmokeLabSuite } from "./smoke-lab.shared";

defineSmokeLabSuite("P1-P4", ciSmokeLabScenarios.slice(0, 4));
