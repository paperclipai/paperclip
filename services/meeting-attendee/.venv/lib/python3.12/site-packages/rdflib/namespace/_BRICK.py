from rdflib.namespace import DefinedNamespace, Namespace
from rdflib.term import URIRef


class BRICK(DefinedNamespace):
    """
    Brick Ontology classes, properties and entity properties. See https://brickschema.org/
    for more information.

    Generated from: https://github.com/BrickSchema/Brick/releases/download/nightly/Brick.ttl
    Date: 2021-09-22T14:32:56
    """

    # http://www.w3.org/2002/07/owl#Class
    AED: URIRef
    AHU: URIRef  # Assembly consisting of sections containing a fan or fans and other necessary equipment to perform one or more of the following functions: circulating, filtration, heating, cooling, heat recovery, humidifying, dehumidifying, and mixing of air. Is usually connected to an air-distribution system.
    Ablutions_Room: URIRef  # A room for performing cleansing rituals before prayer
    Absorption_Chiller: URIRef  # A chiller that utilizes a thermal or/and chemical process to produce the refrigeration effect necessary to provide chilled water. There is no mechanical compression of the refrigerant taking place within the machine, as occurs within more traditional vapor compression type chillers.
    Acceleration_Time_Setpoint: URIRef
    Access_Control_Equipment: URIRef
    Access_Reader: URIRef
    Active_Chilled_Beam: URIRef  # A Chilled Beam with an integral primary air connection that induces air flow through the device.
    Active_Power_Sensor: URIRef  # Measures the portion of power that, averaged over a complete cycle of the AC waveform, results in net transfer of energy in one direction
    Adjust_Sensor: URIRef  # Measures user-provided adjustment of some value
    Air: URIRef  # the invisible gaseous substance surrounding the earth, a mixture mainly of oxygen and nitrogen.
    Air_Alarm: URIRef
    Air_Differential_Pressure_Sensor: (
        URIRef  # Measures the difference in pressure between two regions of air
    )
    Air_Differential_Pressure_Setpoint: URIRef  # Sets the target air differential pressure between an upstream and downstream point in a air duct or conduit
    Air_Diffuser: URIRef  # A device that is a component of the air distribution system that controls the delivery of conditioned and/or ventilating air into a room
    Air_Enthalpy_Sensor: URIRef  # Measures the total heat content of air
    Air_Flow_Deadband_Setpoint: URIRef  # Sets the size of a deadband of air flow
    Air_Flow_Demand_Setpoint: URIRef  # Sets the rate of air flow required for a process
    Air_Flow_Loss_Alarm: URIRef  # An alarm that indicates loss in air flow.
    Air_Flow_Sensor: URIRef  # Measures the rate of flow of air
    Air_Flow_Setpoint: URIRef  # Sets air flow
    Air_Flow_Setpoint_Limit: URIRef  # A parameter that places a lower or upper bound on the range of permitted values of a Air_Flow_Setpoint.
    Air_Grains_Sensor: URIRef  # Measures the mass of water vapor in air
    Air_Handler_Unit: URIRef  # Assembly consisting of sections containing a fan or fans and other necessary equipment to perform one or more of the following functions: circulating, filtration, heating, cooling, heat recovery, humidifying, dehumidifying, and mixing of air. Is usually connected to an air-distribution system.
    Air_Handling_Unit: URIRef
    Air_Humidity_Setpoint: URIRef
    Air_Loop: URIRef  # The set of connected equipment serving one path of air
    Air_Plenum: URIRef  # A component of the HVAC the receives air from the air handling unit or room to distribute or exhaust to or from the building
    Air_Quality_Sensor: URIRef  # A sensor which provides a measure of air quality
    Air_Static_Pressure_Step_Parameter: URIRef
    Air_System: URIRef  # The equipment, distribution systems and terminals that introduce or exhaust, either collectively or individually, the air into and from the building
    Air_Temperature_Alarm: URIRef  # An alarm that indicates the off-normal conditions associated with the temperature of air.
    Air_Temperature_Integral_Time_Parameter: URIRef
    Air_Temperature_Sensor: URIRef  # Measures the temperature of air
    Air_Temperature_Setpoint: URIRef  # Sets temperature of air
    Air_Temperature_Setpoint_Limit: URIRef  # A parameter that places a lower or upper bound on the range of permitted values of a Air_Temperature_Setpoint.
    Air_Temperature_Step_Parameter: URIRef
    Air_Wet_Bulb_Temperature_Sensor: URIRef
    Alarm: URIRef  # Alarm points are signals (either audible or visual) that alert an operator to an off-normal condition which requires some form of corrective action
    Alarm_Delay_Parameter: URIRef  # A parameter determining how long to delay an alarm after sufficient conditions have been met
    Angle_Sensor: URIRef  # Measues the planar angle of some phenomenon
    Auditorium: URIRef  # A space for performances or larger gatherings
    Automated_External_Defibrillator: URIRef
    Automatic_Mode_Command: URIRef  # Controls whether or not a device or controller is operating in "Automatic" mode
    Availability_Status: URIRef  # Indicates if a piece of equipment, system, or functionality is available for operation
    Average_Cooling_Demand_Sensor: URIRef  # Measures the average power consumed by a cooling process as the amount of power consumed over some interval
    Average_Discharge_Air_Flow_Sensor: (
        URIRef  # The computed average flow of discharge air over some interval
    )
    Average_Exhaust_Air_Static_Pressure_Sensor: URIRef  # The computed average static pressure of air in exhaust regions of an HVAC system over some period of time
    Average_Heating_Demand_Sensor: URIRef  # Measures the average power consumed by a heating process as the amount of power consumed over some interval
    Average_Supply_Air_Flow_Sensor: (
        URIRef  # The computed average flow of supply air over some interval
    )
    Average_Zone_Air_Temperature_Sensor: URIRef  # The computed average temperature of air in a zone, over some period of time
    Baseboard_Radiator: URIRef  # Steam, hydronic, or electric heating device located at or near the floor.
    Basement: URIRef  # The floor of a building which is partly or entirely below ground level.
    Battery: URIRef  # A container that stores chemical energy that can be converted into electricity and used as a source of power
    Battery_Energy_Storage_System: URIRef  # A collection of batteries that provides energy storage, along with their supporting equipment
    Battery_Room: URIRef  # A room used to hold batteries for backup power
    Battery_Voltage_Sensor: URIRef  # Measures the capacity of a battery
    Bench_Space: URIRef  # For areas of play in a stadium, the area for partcipants and referees by the side of the field
    Blowdown_Water: URIRef  # Water expelled from a system to remove mineral build up
    Boiler: URIRef  # A closed, pressure vessel that uses fuel or electricity for heating water or other fluids to supply steam or hot water for heating, humidification, or other applications.
    Booster_Fan: URIRef  # Fan activated to increase airflow beyond what is provided by the default configuration
    Box_Mode_Command: URIRef
    Break_Room: URIRef  # A space for people to relax while not working
    Breaker_Panel: URIRef  # Breaker Panel distributes power into various end-uses.
    Breakroom: URIRef  # A space for people to relax while not working
    Broadcast_Room: (
        URIRef  # A space to organize and manage a broadcast. Separate from studio
    )
    Building: URIRef  # An independent unit of the built environment with a characteristic spatial structure, intended to serve at least one function or user activity [ISO 12006-2:2013]
    Building_Air: URIRef  # air contained within a building
    Building_Air_Humidity_Setpoint: URIRef  # Setpoint for humidity in a building
    Building_Air_Static_Pressure_Sensor: (
        URIRef  # The static pressure of air within a building
    )
    Building_Air_Static_Pressure_Setpoint: (
        URIRef  # Sets static pressure of the entire building
    )
    Building_Chilled_Water_Meter: URIRef  # A meter that measures the usage or consumption of chilled water of a whole building
    Building_Electrical_Meter: URIRef  # A meter that measures the usage or consumption of electricity of a whole building
    Building_Gas_Meter: URIRef  # A meter that measures the usage or consumption of gas of a whole building
    Building_Hot_Water_Meter: URIRef  # A meter that measures the usage or consumption of hot water of a whole building
    Building_Meter: URIRef  # A meter that measures usage or consumption of some media for a whole building
    Building_Water_Meter: URIRef  # A meter that measures the usage or consumption of water of a whole building
    Bus_Riser: URIRef  # Bus Risers are commonly fed from a switchgear and rise up through a series of floors to the main power distribution source for each floor.
    Bypass_Air: URIRef  # air in a bypass duct, used to relieve static pressure
    Bypass_Air_Flow_Sensor: URIRef  # Measures the rate of flow of bypass air
    Bypass_Air_Humidity_Setpoint: URIRef  # Humidity setpoint for bypass air
    Bypass_Command: URIRef
    Bypass_Valve: URIRef  # A type of valve installed in a bypass pipeline
    Bypass_Water: URIRef  # Water that circumvents a piece of equipment or system
    Bypass_Water_Flow_Sensor: URIRef  # Measures the rate of flow of bypass water
    Bypass_Water_Flow_Setpoint: URIRef  # Sets the target flow rate of bypass water
    CAV: URIRef
    CO: URIRef  # Carbon Monoxide in the vapor phase
    CO2: URIRef  # Carbon Dioxide in the vapor phase
    CO2_Alarm: URIRef  # An alarm that indicates the off-normal conditions associated with the presence of carbon dioxide.
    CO2_Differential_Sensor: (
        URIRef  # Measures the difference between CO2 levels of inside and outside air
    )
    CO2_Level_Sensor: URIRef  # Measures the concentration of CO2 in air
    CO2_Sensor: URIRef  # Measures properties of CO2 in air
    CO2_Setpoint: URIRef  # Sets some property of CO2
    CO_Differential_Sensor: URIRef
    CO_Level_Sensor: URIRef  # Measures the concentration of CO
    CO_Sensor: URIRef  # Measures properties of CO
    CRAC: URIRef
    Cafeteria: URIRef  # A space to serve food and beverages
    Camera: URIRef
    Capacity_Sensor: URIRef
    Ceiling_Fan: URIRef  # A fan installed on the ceiling of a room for the purpose of air circulation
    Centrifugal_Chiller: URIRef  # A chiller that uses the vapor compression cycle to chill water. It throws off the heat collected from the chilled water plus the heat from the compressor to a water loop
    Change_Filter_Alarm: URIRef  # An alarm that indicates that a filter must be changed
    Chilled_Beam: URIRef  # A device with an integrated coil that performs sensible heating of a space via circulation of room air. Chilled Beams are not designed to perform latent cooling; see Induction Units. Despite their name, Chilled Beams may perform heating or cooling of a space depending on their configuration.
    Chilled_Water: URIRef  # water used as a cooling medium (particularly in air-conditioning systems or in processes) at below ambient temperature.
    Chilled_Water_Coil: URIRef  # A cooling element made of pipe or tube that removes heat from equipment, machines or airflows that is filled with chilled water.
    Chilled_Water_Differential_Pressure_Deadband_Setpoint: (
        URIRef  # Sets the size of a deadband of differential pressure of chilled water
    )
    Chilled_Water_Differential_Pressure_Integral_Time_Parameter: URIRef
    Chilled_Water_Differential_Pressure_Load_Shed_Reset_Status: URIRef
    Chilled_Water_Differential_Pressure_Load_Shed_Setpoint: URIRef
    Chilled_Water_Differential_Pressure_Load_Shed_Status: URIRef
    Chilled_Water_Differential_Pressure_Proportional_Band_Parameter: URIRef
    Chilled_Water_Differential_Pressure_Sensor: URIRef  # Measures the difference in water pressure on either side of a chilled water valve
    Chilled_Water_Differential_Pressure_Setpoint: URIRef  # Sets the target water differential pressure between an upstream and downstream point in a water pipe or conduit used to carry chilled water
    Chilled_Water_Differential_Pressure_Step_Parameter: URIRef
    Chilled_Water_Differential_Temperature_Sensor: URIRef  # Measures the difference in temperature between the entering water to the chiller or other water cooling device and leaving water from the same chiller or other water cooling device
    Chilled_Water_Discharge_Flow_Sensor: (
        URIRef  # Measures the rate of flow of chilled discharge water
    )
    Chilled_Water_Discharge_Flow_Setpoint: (
        URIRef  # Sets the target flow rate of chilled discharge water
    )
    Chilled_Water_Flow_Sensor: (
        URIRef  # Measures the rate of flow in a chilled water circuit
    )
    Chilled_Water_Flow_Setpoint: URIRef  # Sets the target flow rate of chilled water
    Chilled_Water_Loop: URIRef  # A collection of equipment that transport and regulate chilled water among each other
    Chilled_Water_Meter: (
        URIRef  # A meter that measures the usage or consumption of chilled water
    )
    Chilled_Water_Pump: URIRef  # A pump that performs work on chilled water; typically part of a chilled water system
    Chilled_Water_Pump_Differential_Pressure_Deadband_Setpoint: URIRef  # Sets the size of a deadband of differential pressure of chilled water in a chilled water pump
    Chilled_Water_Return_Flow_Sensor: (
        URIRef  # Measures the rate of flow of chilled return water
    )
    Chilled_Water_Return_Temperature_Sensor: URIRef  # Measures the temperature of chilled water that is returned to a cooling tower
    Chilled_Water_Static_Pressure_Setpoint: (
        URIRef  # Sets static pressure of chilled water
    )
    Chilled_Water_Supply_Flow_Sensor: (
        URIRef  # Measures the rate of flow of chilled supply water
    )
    Chilled_Water_Supply_Flow_Setpoint: (
        URIRef  # Sets the target flow rate of chilled supply water
    )
    Chilled_Water_Supply_Temperature_Sensor: URIRef  # Measures the temperature of chilled water that is supplied from a chiller
    Chilled_Water_System: URIRef  # The equipment, devices and conduits that handle the production and distribution of chilled water in a building
    Chilled_Water_System_Enable_Command: (
        URIRef  # Enables operation of the chilled water system
    )
    Chilled_Water_Temperature_Sensor: (
        URIRef  # Measures the temperature of chilled water
    )
    Chilled_Water_Temperature_Setpoint: URIRef  # Sets the temperature of chilled water
    Chilled_Water_Valve: URIRef  # A valve that modulates the flow of chilled water
    Chiller: URIRef  # Refrigerating machine used to transfer heat between fluids. Chillers are either direct expansion with a compressor or absorption type.
    Class: URIRef
    Close_Limit: URIRef  # A parameter that places a lower or upper bound on the range of permitted values of a Close_Setpoint.
    Coil: URIRef  # Cooling or heating element made of pipe or tube that may or may not be finned and formed into helical or serpentine shape (ASHRAE Dictionary)
    Cold_Box: URIRef  # in a gas separation unit, the insulated section that contains the low-temperature heat exchangers and distillation columns.
    Coldest_Zone_Air_Temperature_Sensor: URIRef  # The zone temperature that is coldest; drives the supply temperature of hot air. A computed value rather than a physical sensor. Also referred to as a 'Lowest Zone Air Temperature Sensor'
    Collection: URIRef
    Collection_Basin_Water: URIRef  # Water transiently collected and directed to the sump or pump suction line, typically integral with a cooling tower
    Collection_Basin_Water_Heater: URIRef  # Basin heaters prevent cold water basin freeze-up, e.g. in cooling towers, closed circuit fluid coolers, or evaporative condensers
    Collection_Basin_Water_Level_Alarm: URIRef  # An alarm that indicates a high or low level of water in the collection basin, e.g. within a Cooling_Tower
    Collection_Basin_Water_Level_Sensor: URIRef  # Measures the level of the water in the collection basin, e.g. within a Cooling_Tower
    Collection_Basin_Water_Temperature_Sensor: URIRef  # Measures the temperature of the water in the collection basin, e.g. within a Cooling_Tower
    Command: URIRef  # A Command is an output point that directly determines the behavior of equipment and/or affects relevant operational points.
    Common_Space: (
        URIRef  # A class of spaces that are used by multiple people at the same time
    )
    Communication_Loss_Alarm: URIRef  # An alarm that indicates a loss of communication e.g. with a device or controller
    Compressor: URIRef  # (1) device for mechanically increasing the pressure of a gas. (2) often described as being either open, hermetic, or semihermetic to describe how the compressor and motor drive is situated in relation to the gas or vapor being compressed. Types include centrifugal, axial flow, reciprocating, rotary screw, rotary vane, scroll, or diaphragm. 1. device for mechanically increasing the pressure of a gas. 2. specific machine, with or without accessories, for compressing refrigerant vapor.
    Computer_Room_Air_Conditioning: URIRef  # A device that monitors and maintains the temperature, air distribution and humidity in a network room or data center.
    Concession: URIRef  # A space to sell food and beverages. Usually embedded in a larger space and does not include a space where people consume their purchases
    Condensate_Leak_Alarm: (
        URIRef  # An alarm that indicates a leak of condensate from a cooling system
    )
    Condenser: URIRef  # A heat exchanger in which the primary heat transfer vapor changes its state to a liquid phase.
    Condenser_Heat_Exchanger: URIRef  # A heat exchanger in which the primary heat transfer vapor changes its state to a liquid phase.
    Condenser_Water: URIRef  # Water used used to remove heat through condensation
    Condenser_Water_Bypass_Valve: (
        URIRef  # A valve installed in a bypass line of a condenser water loop
    )
    Condenser_Water_Isolation_Valve: (
        URIRef  # An isolation valve installed in the condenser water loop
    )
    Condenser_Water_Pump: URIRef  # A pump that is part of a condenser system; the pump circulates condenser water from the chiller back to the cooling tower
    Condenser_Water_System: URIRef  # A heat rejection system consisting of (typically) cooling towers, condenser water pumps, chillers and the piping connecting the components
    Condenser_Water_Temperature_Sensor: (
        URIRef  # Measures the temperature of condenser water
    )
    Condenser_Water_Valve: URIRef  # A valve that modulates the flow of condenser water
    Condensing_Natural_Gas_Boiler: URIRef  # A closed, pressure vessel that uses natural gas and heat exchanger that capture and reuse any latent heat for heating water or other fluids to supply steam or hot water for heating, humidification, or other applications.
    Conductivity_Sensor: URIRef  # Measures electrical conductance
    Conference_Room: URIRef  # A space dedicated in which to hold a meetings
    Constant_Air_Volume_Box: URIRef  # A terminal unit for which supply air flow rate is constant and the supply air temperature is varied to meet thermal load
    Contact_Sensor: URIRef  # Senses or detects contact, such as for determining if a door is closed.
    Control_Room: URIRef  # A space from which operations are managed
    Cooling_Coil: URIRef  # A cooling element made of pipe or tube that removes heat from equipment, machines or airflows. Typically filled with either refrigerant or cold water.
    Cooling_Command: URIRef  # Controls the amount of cooling to be delivered (typically as a proportion of total cooling output)
    Cooling_Demand_Sensor: URIRef  # Measures the amount of power consumed by a cooling process; typically found by multiplying the tonnage of a unit (e.g. RTU) by the efficiency rating in kW/ton
    Cooling_Demand_Setpoint: URIRef  # Sets the rate required for cooling
    Cooling_Discharge_Air_Flow_Setpoint: URIRef  # Sets discharge air flow for cooling
    Cooling_Discharge_Air_Temperature_Deadband_Setpoint: (
        URIRef  # Sets the size of a deadband of temperature of cooling discharge air
    )
    Cooling_Discharge_Air_Temperature_Integral_Time_Parameter: URIRef
    Cooling_Discharge_Air_Temperature_Proportional_Band_Parameter: URIRef
    Cooling_Start_Stop_Status: URIRef
    Cooling_Supply_Air_Flow_Setpoint: URIRef  # Sets supply air flow rate for cooling
    Cooling_Supply_Air_Temperature_Deadband_Setpoint: (
        URIRef  # Sets the size of a deadband of temperature of supply air for cooling
    )
    Cooling_Supply_Air_Temperature_Integral_Time_Parameter: URIRef
    Cooling_Supply_Air_Temperature_Proportional_Band_Parameter: URIRef
    Cooling_Temperature_Setpoint: URIRef  # Sets temperature for cooling
    Cooling_Tower: URIRef  # A cooling tower is a heat rejection device that rejects waste heat to the atmosphere through the cooling of a water stream to a lower temperature. Cooling towers may either use the evaporation of water to remove process heat and cool the working fluid to near the wet-bulb air temperature or, in the case of closed circuit dry cooling towers, rely solely on air to cool the working fluid to near the dry-bulb air temperature.
    Cooling_Tower_Fan: URIRef  # A fan that pulls air through a cooling tower and across the louvers where the water falls to aid in heat exchange by the process of evaporation
    Cooling_Valve: URIRef  # A valve that controls air temperature by modulating the amount of cold water flowing through a cooling coil
    Copy_Room: URIRef  # A room set aside for common office equipment, including printers and copiers
    Core_Temperature_Sensor: URIRef  # Measures the internal temperature of the radiant layer at the heat source or sink level of the radiant heating and cooling HVAC system.
    Core_Temperature_Setpoint: URIRef  # Sets temperature for the core, i.e. the temperature at the heat source or sink level, of the radiant panel.
    Cubicle: URIRef  # A smaller space set aside for an individual, but not with a door and without full-height walls
    Current_Imbalance_Sensor: URIRef  # A sensor which measures the current difference (imbalance) between phases of an electrical system
    Current_Limit: URIRef  # A parameter that places a lower or upper bound on the range of permitted values of a Current_Setpoint.
    Current_Output_Sensor: URIRef  # Senses the amperes of electrical current produced as output by a device
    Current_Sensor: (
        URIRef  # Senses the amperes of electrical current passing through the sensor
    )
    Curtailment_Override_Command: URIRef
    Cycle_Alarm: URIRef  # An alarm that indicates off-normal conditions associated with HVAC cycles
    DC_Bus_Voltage_Sensor: URIRef  # Measures the voltage across a DC bus
    DOAS: URIRef  # See Dedicated_Outdoor_Air_System_Unit
    Damper: URIRef  # Element inserted into an air-distribution system or element of an air-distribution system permitting modification of the air resistance of the system and consequently changing the airflow rate or shutting off the airflow.
    Damper_Command: URIRef  # Controls properties of dampers
    Damper_Position_Command: (
        URIRef  # Controls the position (the degree of openness) of a damper
    )
    Damper_Position_Sensor: URIRef  # Measures the current position of a damper in terms of the percent of fully open
    Damper_Position_Setpoint: URIRef  # Sets the position of damper
    Deadband_Setpoint: URIRef  # Sets the size of a deadband
    Deceleration_Time_Setpoint: URIRef
    Dedicated_Outdoor_Air_System_Unit: URIRef  # A device that conditions and delivers 100% outdoor air to its assigned spaces. It decouples air-conditioning of the outdoor air, usually used to provide minimum outdoor air ventilation, from conditioning of the internal loads.
    Dehumidification_Start_Stop_Status: URIRef
    Deionised_Water_Conductivity_Sensor: (
        URIRef  # Measures the electrical conductance of deionised water
    )
    Deionised_Water_Level_Sensor: (
        URIRef  # Measures the height/level of deionised water in some container
    )
    Deionized_Water: URIRef  # Water which has been purified by removing its ions (constituting the majority of non-particulate contaminants)
    Deionized_Water_Alarm: URIRef  # An alarm that indicates deionized water leaks.
    Delay_Parameter: URIRef  # A parameter determining how long to delay a subsequent action to take place after a received signal
    Demand_Sensor: URIRef  # Measures the amount of power consumed by the use of some process; typically found by multiplying the tonnage of a unit (e.g. RTU) by the efficiency rating in kW/ton
    Demand_Setpoint: URIRef  # Sets the rate required for a process
    Derivative_Gain_Parameter: URIRef
    Derivative_Time_Parameter: URIRef
    Detention_Room: (
        URIRef  # A space for the temporary involuntary confinement of people
    )
    Dew_Point_Setpoint: URIRef  # Sets dew point
    Dewpoint_Sensor: URIRef  # Senses the dewpoint temperature . Dew point is the temperature to which air must be cooled to become saturated with water vapor
    Differential_Air_Temperature_Setpoint: (
        URIRef  # Sets temperature of differential air
    )
    Differential_Pressure_Bypass_Valve: URIRef  # A 2-way, self contained proportional valve with an integral differential pressure adjustment setting.
    Differential_Pressure_Deadband_Setpoint: (
        URIRef  # Sets the size of a deadband of differential pressure
    )
    Differential_Pressure_Integral_Time_Parameter: URIRef
    Differential_Pressure_Load_Shed_Status: URIRef
    Differential_Pressure_Proportional_Band: URIRef
    Differential_Pressure_Sensor: (
        URIRef  # Measures the difference between two applied pressures
    )
    Differential_Pressure_Setpoint: URIRef  # Sets differential pressure
    Differential_Pressure_Setpoint_Limit: URIRef  # A parameter that places a lower or upper bound on the range of permitted values of a Differential_Pressure_Setpoint.
    Differential_Pressure_Step_Parameter: URIRef
    Differential_Speed_Sensor: URIRef
    Differential_Speed_Setpoint: URIRef  # Sets differential speed
    Differential_Supply_Return_Water_Temperature_Sensor: URIRef  # Measures the difference in temperature between return and supply water of water a circuit
    Dimmer: URIRef  # A switch providing continuous control over all or part of a lighting installation; typically potentiometer-based
    Direct_Expansion_Cooling_Coil: URIRef
    Direct_Expansion_Heating_Coil: URIRef
    Direction_Command: URIRef  # Commands that affect the direction of some phenomenon
    Direction_Sensor: (
        URIRef  # Measures the direction in degrees in which a phenomenon is occurring
    )
    Direction_Status: URIRef  # Indicates which direction a device is operating in
    Disable_Command: URIRef  # Commands that disable functionality
    Disable_Differential_Enthalpy_Command: (
        URIRef  # Disables the use of differential enthalpy control
    )
    Disable_Differential_Temperature_Command: (
        URIRef  # Disables the use of differential temperature control
    )
    Disable_Fixed_Enthalpy_Command: URIRef  # Disables the use of fixed enthalpy control
    Disable_Fixed_Temperature_Command: (
        URIRef  # Disables the use of fixed temperature temperature
    )
    Disable_Hot_Water_System_Outside_Air_Temperature_Setpoint: URIRef  # Disables hot water system when outside air temperature reaches the indicated value
    Disable_Status: URIRef  # Indicates if functionality has been disabled
    Discharge_Air: URIRef  # the air exiting the registers (vents).
    Discharge_Air_Dewpoint_Sensor: URIRef  # Measures dewpoint of discharge air
    Discharge_Air_Duct_Pressure_Status: (
        URIRef  # Indicates if air pressure in discharge duct is within expected bounds
    )
    Discharge_Air_Flow_Demand_Setpoint: (
        URIRef  # Sets the rate of discharge air flow required for a process
    )
    Discharge_Air_Flow_High_Reset_Setpoint: URIRef
    Discharge_Air_Flow_Low_Reset_Setpoint: URIRef
    Discharge_Air_Flow_Reset_Setpoint: URIRef  # Setpoints used in Reset strategies
    Discharge_Air_Flow_Sensor: URIRef  # Measures the rate of flow of discharge air
    Discharge_Air_Flow_Setpoint: URIRef  # Sets discharge air flow
    Discharge_Air_Humidity_Sensor: (
        URIRef  # Measures the relative humidity of discharge air
    )
    Discharge_Air_Humidity_Setpoint: URIRef  # Humidity setpoint for discharge air
    Discharge_Air_Smoke_Detection_Alarm: URIRef
    Discharge_Air_Static_Pressure_Deadband_Setpoint: (
        URIRef  # Sets the size of a deadband of static pressure of discharge air
    )
    Discharge_Air_Static_Pressure_Integral_Time_Parameter: URIRef
    Discharge_Air_Static_Pressure_Proportional_Band_Parameter: URIRef
    Discharge_Air_Static_Pressure_Sensor: (
        URIRef  # The static pressure of air within discharge regions of an HVAC system
    )
    Discharge_Air_Static_Pressure_Setpoint: (
        URIRef  # Sets static pressure of discharge air
    )
    Discharge_Air_Static_Pressure_Step_Parameter: URIRef
    Discharge_Air_Temperature_Alarm: URIRef  # An alarm that indicates the off-normal conditions associated with the temperature of discharge air.
    Discharge_Air_Temperature_Cooling_Setpoint: (
        URIRef  # Sets temperature of discharge air for cooling
    )
    Discharge_Air_Temperature_Deadband_Setpoint: (
        URIRef  # Sets the size of a deadband of temperature of discharge air
    )
    Discharge_Air_Temperature_Heating_Setpoint: (
        URIRef  # Sets temperature of discharge air for heating
    )
    Discharge_Air_Temperature_High_Reset_Setpoint: URIRef
    Discharge_Air_Temperature_Low_Reset_Setpoint: URIRef
    Discharge_Air_Temperature_Proportional_Band_Parameter: URIRef
    Discharge_Air_Temperature_Reset_Differential_Setpoint: URIRef
    Discharge_Air_Temperature_Sensor: (
        URIRef  # Measures the temperature of discharge air
    )
    Discharge_Air_Temperature_Setpoint: URIRef  # Sets temperature of discharge air
    Discharge_Air_Temperature_Setpoint_Limit: URIRef  # A parameter that places a lower or upper bound on the range of permitted values of a Discharge_Air_Temperature_Setpoint.
    Discharge_Air_Temperature_Step_Parameter: URIRef
    Discharge_Air_Velocity_Pressure_Sensor: URIRef
    Discharge_Chilled_Water: URIRef
    Discharge_Fan: URIRef  # Fan moving air discharged from HVAC vents
    Discharge_Hot_Water: URIRef
    Discharge_Water: URIRef
    Discharge_Water_Differential_Pressure_Deadband_Setpoint: URIRef  # Sets the size of a deadband of differential pressure of discharge water
    Discharge_Water_Differential_Pressure_Integral_Time_Parameter: URIRef
    Discharge_Water_Differential_Pressure_Proportional_Band_Parameter: URIRef
    Discharge_Water_Flow_Sensor: URIRef  # Measures the rate of flow of discharge water
    Discharge_Water_Flow_Setpoint: (
        URIRef  # Sets the target flow rate of discharge water
    )
    Discharge_Water_Temperature_Alarm: URIRef  # An alarm that indicates the off-normal conditions associated with temperature of the discharge water.
    Discharge_Water_Temperature_Proportional_Band_Parameter: URIRef
    Discharge_Water_Temperature_Sensor: (
        URIRef  # Measures the temperature of discharge water
    )
    Discharge_Water_Temperature_Setpoint: URIRef  # Sets temperature of discharge water
    Disconnect_Switch: URIRef  # Building power is most commonly provided by utility company through a master disconnect switch (sometimes called a service disconnect) in the main electrical room of a building. The Utility Company provided master disconnect switch often owns or restricts access to this switch. There can also be other cases where a disconnect is placed into an electrical system to allow service cut-off to a portion of the building.
    Displacement_Flow_Air_Diffuser: URIRef  # An air diffuser that is designed for low discharge air speeds to minimize turbulence and induction of room air. This diffuser is used with displacement ventilation systems.
    Distribution_Frame: URIRef  # A class of spaces where the cables carrying signals meet and connect, e.g. a wiring closet or a broadcast downlink room
    Domestic_Hot_Water_Supply_Temperature_Sensor: URIRef  # Measures the temperature of domestic water supplied by a hot water system
    Domestic_Hot_Water_Supply_Temperature_Setpoint: (
        URIRef  # Sets temperature of supplying part of domestic hot water
    )
    Domestic_Hot_Water_System: URIRef  # The equipment, devices and conduits that handle the production and distribution of domestic hot water in a building
    Domestic_Hot_Water_System_Enable_Command: (
        URIRef  # Enables operation of the domestic hot water system
    )
    Domestic_Hot_Water_Temperature_Setpoint: (
        URIRef  # Sets temperature of domestic hot water
    )
    Domestic_Hot_Water_Valve: (
        URIRef  # A valve regulating the flow of domestic hot water
    )
    Domestic_Water: (
        URIRef  # Tap water for drinking, washing, cooking, and flushing of toliets
    )
    Domestic_Water_Loop: URIRef
    Drench_Hose: URIRef
    Drive_Ready_Status: URIRef  # Indicates if a hard drive or other storage device is ready to be used, e.g. in the context of RAID
    Duration_Sensor: URIRef  # Measures the duration of a phenomenon or event
    ESS_Panel: URIRef  # See Embedded_Surface_System_Panel
    EconCycle_Start_Stop_Status: URIRef
    Economizer: URIRef  # Device that, on proper variable sensing, initiates control signals or actions to conserve energy. A control system that reduces the mechanical heating and cooling requirement.
    Economizer_Damper: URIRef  # A damper that is part of an economizer that is used to module the flow of air
    Effective_Air_Temperature_Cooling_Setpoint: URIRef
    Effective_Air_Temperature_Heating_Setpoint: URIRef
    Effective_Air_Temperature_Setpoint: URIRef
    Effective_Discharge_Air_Temperature_Setpoint: URIRef
    Effective_Return_Air_Temperature_Setpoint: URIRef
    Effective_Room_Air_Temperature_Setpoint: URIRef
    Effective_Supply_Air_Temperature_Setpoint: URIRef
    Effective_Zone_Air_Temperature_Setpoint: URIRef
    Electric_Baseboard_Radiator: (
        URIRef  # Electric heating device located at or near the floor
    )
    Electric_Boiler: URIRef  # A closed, pressure vessel that uses electricity for heating water or other fluids to supply steam or hot water for heating, humidification, or other applications.
    Electric_Radiator: URIRef  # Electric heating device
    Electrical_Equipment: URIRef
    Electrical_Meter: (
        URIRef  # A meter that measures the usage or consumption of electricity
    )
    Electrical_Power_Sensor: (
        URIRef  # Measures the amount of instantaneous electric power consumed
    )
    Electrical_Room: URIRef  # A class of service rooms that house electrical equipment for a building
    Electrical_System: URIRef  # Devices that serve or are part of the electrical subsystem in the building
    Elevator: URIRef  # A device that provides vertical transportation between floors, levels or decks of a building, vessel or other structure
    Elevator_Shaft: (
        URIRef  # The vertical space in which an elevator ascends and descends
    )
    Elevator_Space: (
        URIRef  # The vertical space in which an elevator ascends and descends
    )
    Embedded_Surface_System_Panel: URIRef  # Radiant panel heating and cooling system where the energy heat source or sink is embedded in a radiant layer which is thermally insulated from the building structure.
    Embedded_Temperature_Sensor: URIRef  # Measures the internal temperature of the radiant layer of the radiant heating and cooling HVAC system.
    Embedded_Temperature_Setpoint: URIRef  # Sets temperature for the internal material, e.g. concrete slab, of the radiant panel.
    Emergency_Air_Flow_System: URIRef
    Emergency_Air_Flow_System_Status: URIRef
    Emergency_Alarm: URIRef  # Alarms that indicate off-normal conditions associated with emergency systems
    Emergency_Generator_Alarm: URIRef  # An alarm that indicates off-normal conditions associated with an emergency generator
    Emergency_Generator_Status: URIRef  # Indicates if an emergency generator is active
    Emergency_Phone: URIRef
    Emergency_Power_Off_System: URIRef  # A system that can power down a single piece of equipment or a single system from a single point
    Emergency_Power_Off_System_Activated_By_High_Temperature_Status: URIRef
    Emergency_Power_Off_System_Activated_By_Leak_Detection_System_Status: URIRef
    Emergency_Power_Off_System_Status: URIRef
    Emergency_Push_Button_Status: (
        URIRef  # Indicates if an emergency button has been pushed
    )
    Emergency_Wash_Station: URIRef
    Employee_Entrance_Lobby: URIRef  # An open space near an entrance that is typically only used for employees
    Enable_Command: URIRef  # Commands that enable functionality
    Enable_Differential_Enthalpy_Command: (
        URIRef  # Enables the use of differential enthalpy control
    )
    Enable_Differential_Temperature_Command: (
        URIRef  # Enables the use of differential temperature control
    )
    Enable_Fixed_Enthalpy_Command: URIRef  # Enables the use of fixed enthalpy control
    Enable_Fixed_Temperature_Command: (
        URIRef  # Enables the use of fixed temperature control
    )
    Enable_Hot_Water_System_Outside_Air_Temperature_Setpoint: URIRef  # Enables hot water system when outside air temperature reaches the indicated value
    Enable_Status: (
        URIRef  # Indicates if a system or piece of functionality has been enabled
    )
    Enclosed_Office: URIRef  # A space for individuals to work with walls and a door
    Energy_Generation_System: (
        URIRef  # A collection of devices that generates electricity
    )
    Energy_Sensor: URIRef  # Measures energy consumption
    Energy_Storage: (
        URIRef  # Devices or equipment that store energy in its various forms
    )
    Energy_Storage_System: URIRef  # A collection of devices that stores electricity
    Energy_System: URIRef  # A collection of devices that generates, stores or transports electricity
    Energy_Usage_Sensor: (
        URIRef  # Measures the total amount of energy used over some period of time
    )
    Energy_Zone: URIRef  # A space or group of spaces that are managed or monitored as one unit for energy purposes
    Entering_Water: URIRef  # Water that is entering a piece of equipment or system
    Entering_Water_Flow_Sensor: URIRef  # Measures the rate of flow of water entering a piece of equipment or system
    Entering_Water_Flow_Setpoint: URIRef  # Sets the target flow rate of entering water
    Entering_Water_Temperature_Sensor: URIRef  # Measures the temperature of water entering a piece of equipment or system
    Entering_Water_Temperature_Setpoint: URIRef  # Sets temperature of entering water
    Enthalpy_Sensor: URIRef  # Measures the total heat content of some substance
    Enthalpy_Setpoint: URIRef  # Sets enthalpy
    Entrance: URIRef  # The location and space of a building where people enter and exit the building
    Environment_Box: URIRef  # (also known as climatic chamber), enclosed space designed to create a particular environment.
    Equipment: URIRef  # devices that serve all or part of the building and may include electric power, lighting, transportation, or service water heating, including, but not limited to, furnaces, boilers, air conditioners, heat pumps, chillers, water heaters, lamps, luminaires, ballasts, elevators, escalators, or other devices or installations.
    Equipment_Room: URIRef  # A telecommunications room where equipment that serves the building is stored
    Evaporative_Heat_Exchanger: URIRef
    Even_Month_Status: URIRef
    Exercise_Room: URIRef  # An indoor room used for exercise and physical activities
    Exhaust_Air: URIRef  # air that must be removed from a space due to contaminants, regardless of pressurization
    Exhaust_Air_Dewpoint_Sensor: URIRef  # Measures dewpoint of exhaust air
    Exhaust_Air_Differential_Pressure_Sensor: URIRef  # Measures the difference in pressure between an upstream and downstream of an air duct or other air conduit used to exhaust air from the building
    Exhaust_Air_Differential_Pressure_Setpoint: URIRef  # Sets the target air differential pressure between an upstream and downstream point in a exhaust air duct or conduit
    Exhaust_Air_Flow_Integral_Time_Parameter: URIRef
    Exhaust_Air_Flow_Proportional_Band_Parameter: URIRef
    Exhaust_Air_Flow_Sensor: URIRef  # Measures the rate of flow of exhaust air
    Exhaust_Air_Flow_Setpoint: URIRef  # Sets exhaust air flow rate
    Exhaust_Air_Humidity_Sensor: URIRef  # Measures the relative humidity of exhaust air
    Exhaust_Air_Humidity_Setpoint: URIRef  # Humidity setpoint for exhaust air
    Exhaust_Air_Stack_Flow_Deadband_Setpoint: (
        URIRef  # Sets the size of a deadband of exhaust air stack flow
    )
    Exhaust_Air_Stack_Flow_Integral_Time_Parameter: URIRef
    Exhaust_Air_Stack_Flow_Proportional_Band_Parameter: URIRef
    Exhaust_Air_Stack_Flow_Sensor: (
        URIRef  # Measures the rate of flow of air in the exhaust air stack
    )
    Exhaust_Air_Stack_Flow_Setpoint: URIRef  # Sets exhaust air stack flow rate
    Exhaust_Air_Static_Pressure_Proportional_Band_Parameter: URIRef
    Exhaust_Air_Static_Pressure_Sensor: (
        URIRef  # The static pressure of air within exhaust regions of an HVAC system
    )
    Exhaust_Air_Static_Pressure_Setpoint: URIRef  # Sets static pressure of exhaust air
    Exhaust_Air_Temperature_Sensor: URIRef  # Measures the temperature of exhaust air
    Exhaust_Air_Velocity_Pressure_Sensor: URIRef
    Exhaust_Damper: URIRef  # A damper that modulates the flow of exhaust air
    Exhaust_Fan: URIRef  # Fan moving exhaust air -- air that must be removed from a space due to contaminants
    Exhaust_Fan_Disable_Command: URIRef  # Disables operation of the exhaust fan
    Exhaust_Fan_Enable_Command: URIRef  # Enables operation of the exhaust fan
    Eye_Wash_Station: URIRef
    FCU: URIRef  # See Fan_Coil_Unit
    Failure_Alarm: URIRef  # Alarms that indicate the failure of devices, equipment, systems and control loops
    Fan: URIRef  # Any device with two or more blades or vanes attached to a rotating shaft used to produce an airflow for the purpose of comfort, ventilation, exhaust, heating, cooling, or any other gaseous transport.
    Fan_Coil_Unit: URIRef  # Terminal device consisting of a heating and/or cooling heat exchanger or 'coil' and fan that is used to control the temperature in the space where it is installed
    Fan_On_Off_Status: URIRef
    Fan_Status: URIRef  # Indicates properties of fans
    Fan_VFD: URIRef  # Variable-frequency drive for fans
    Fault_Reset_Command: URIRef  # Clears a fault status
    Fault_Status: (
        URIRef  # Indicates the presence of a fault in a device, system or control loop
    )
    Field_Of_Play: URIRef  # The area of a stadium where athletic events occur, e.g. the soccer pitch
    Filter: URIRef  # Device to remove gases from a mixture of gases or to remove solid material from a fluid
    Filter_Differential_Pressure_Sensor: (
        URIRef  # Measures the difference in pressure on either side of a filter
    )
    Filter_Reset_Command: URIRef
    Filter_Status: URIRef  # Indicates if a filter needs to be replaced
    Final_Filter: URIRef  # The last, high-efficiency filter installed in a sequence to remove the finest particulates from the substance being filtered
    Fire_Control_Panel: URIRef  # A panel-mounted device that provides status and control of a fire safety system
    Fire_Safety_Equipment: URIRef
    Fire_Safety_System: URIRef  # A system containing devices and equipment that monitor, detect and suppress fire hazards
    Fire_Sensor: URIRef  # Measures the presence of fire
    Fire_Zone: URIRef  # combustion chamber in a furnace or boiler.
    First_Aid_Kit: URIRef
    First_Aid_Room: URIRef  # A room for a person with minor injuries can be treated or temporarily treated until transferred to a more advanced medical facility
    Floor: URIRef  # A level, typically representing a horizontal aggregation of spaces that are vertically bound. (referring to IFC)
    Flow_Sensor: URIRef  # Measures the rate of flow of some substance
    Flow_Setpoint: URIRef  # Sets flow
    Fluid: URIRef  # substance, as a liquid or gas, that is capable of flowing and that changes shape when acted on by a force.
    Food_Service_Room: URIRef  # A space used in the production, storage, serving, or cleanup of food and beverages
    Formaldehyde_Level_Sensor: (
        URIRef  # Measures the concentration of formaldehyde in air
    )
    Freeze_Status: (
        URIRef  # Indicates if a substance contained within a vessel has frozen
    )
    Freezer: URIRef  # cold chamber usually kept at a temperature of 22°F to 31°F (–5°C to –1°C), with high-volume air circulation.
    Frequency_Command: URIRef  # Controls the frequency of a device's operation (e.g. rotational frequency)
    Frequency_Sensor: URIRef  # Measures the frequency of a phenomenon or aspect of a phenomenon, e.g. the frequency of a fan turning
    Fresh_Air_Fan: URIRef  # Fan moving fresh air -- air that is supplied into the building from the outdoors
    Fresh_Air_Setpoint_Limit: URIRef  # A parameter that places a lower or upper bound on the range of permitted values of a Fresh_Air_Setpoint.
    Frost: URIRef  # frost formed on the cold surface (tubes, plates) of a cooling coil.
    Frost_Sensor: (
        URIRef  # Senses the presence of frost or conditions that may cause frost
    )
    Fuel_Oil: URIRef  # Petroleum based oil burned for energy
    Fume_Hood: URIRef  # A fume-collection device mounted over a work space, table, or shelf and serving to conduct unwanted gases away from the area enclosed.
    Fume_Hood_Air_Flow_Sensor: URIRef  # Measures the rate of flow of air in a fume hood
    Furniture: URIRef  # Movable objects intended to support various human activities such as seating, eating and sleeping
    Gain_Parameter: URIRef
    Gas: URIRef  # state of matter in which substances exist in the form of nonaggregated molecules and which, within acceptable limits of accuracy, satisfy the ideal gas laws; usually a highly superheated vapor. See [[state]].
    Gas_Distribution: URIRef  # Utilize a gas distribution source to represent how gas is distributed across multiple destinations
    Gas_Meter: URIRef  # A meter that measures the usage or consumption of gas
    Gas_Sensor: URIRef  # Measures gas concentration (other than CO2)
    Gas_System: URIRef
    Gas_Valve: URIRef
    Gasoline: URIRef  # Petroleum derived liquid used as a fuel source
    Gatehouse: URIRef  # The standalone building used to manage the entrance to a campus or building grounds
    Generator_Room: (
        URIRef  # A room for electrical equipment, specifically electrical generators.
    )
    Glycol: URIRef
    HVAC_Equipment: URIRef  # See Heating_Ventilation_Air_Conditioning_System
    HVAC_System: URIRef  # See Heating_Ventilation_Air_Conditioning_System
    HVAC_Zone: URIRef  # a space or group of spaces, within a building with heating, cooling, and ventilating requirements, that are sufficiently similar so that desired conditions (e.g., temperature) can be maintained throughout using a single sensor (e.g., thermostat or temperature sensor).
    HX: URIRef  # See Heat_Exchanger
    Hail: (
        URIRef  # pellets of frozen rain which fall in showers from cumulonimbus clouds.
    )
    Hail_Sensor: URIRef  # Measures hail in terms of its size and damage potential
    Hallway: URIRef  # A common space, used to connect other parts of a building
    Hazardous_Materials_Storage: URIRef  # A storage space set aside (usually with restricted access) for the storage of materials that can be hazardous to living beings or the environment
    Heat_Exchanger: URIRef  # A heat exchanger is a piece of equipment built for efficient heat transfer from one medium to another. The media may be separated by a solid wall to prevent mixing or they may be in direct contact (BEDES)
    Heat_Exchanger_Supply_Water_Temperature_Sensor: (
        URIRef  # Measures the temperature of water supplied by a heat exchanger
    )
    Heat_Exchanger_System_Enable_Status: (
        URIRef  # Indicates if the heat exchanger system has been enabled
    )
    Heat_Recovery_Hot_Water_System: URIRef
    Heat_Sensor: URIRef  # Measures heat
    Heat_Wheel: URIRef  # A rotary heat exchanger positioned within the supply and exhaust air streams of an air handling system in order to recover heat energy
    Heat_Wheel_VFD: URIRef  # A VFD that drives a heat wheel
    Heating_Coil: URIRef  # A heating element typically made of pipe, tube or wire that emits heat. Typically filled with hot water, or, in the case of wire, uses electricity.
    Heating_Command: URIRef  # Controls the amount of heating to be delivered (typically as a proportion of total heating output)
    Heating_Demand_Sensor: URIRef  # Measures the amount of power consumed by a heating process; typically found by multiplying the tonnage of a unit (e.g. RTU) by the efficiency rating in kW/ton
    Heating_Demand_Setpoint: URIRef  # Sets the rate required for heating
    Heating_Discharge_Air_Flow_Setpoint: URIRef  # Sets discharge air flow for heating
    Heating_Discharge_Air_Temperature_Deadband_Setpoint: (
        URIRef  # Sets the size of a deadband of temperature of heating discharge air
    )
    Heating_Discharge_Air_Temperature_Integral_Time_Parameter: URIRef
    Heating_Discharge_Air_Temperature_Proportional_Band_Parameter: URIRef
    Heating_Start_Stop_Status: URIRef
    Heating_Supply_Air_Flow_Setpoint: URIRef  # Sets supply air flow rate for heating
    Heating_Supply_Air_Temperature_Deadband_Setpoint: (
        URIRef  # Sets the size of a deadband of temperature of supply air for heating
    )
    Heating_Supply_Air_Temperature_Integral_Time_Parameter: URIRef
    Heating_Supply_Air_Temperature_Proportional_Band_Parameter: URIRef
    Heating_Temperature_Setpoint: URIRef  # Sets temperature for heating
    Heating_Thermal_Power_Sensor: URIRef
    Heating_Valve: URIRef  # A valve that controls air temperature by modulating the amount of hot water flowing through a heating coil
    Heating_Ventilation_Air_Conditioning_System: URIRef  # The equipment, distribution systems and terminals that provide, either collectively or individually, the processes of heating, ventilating or air conditioning to a building or portion of a building
    High_CO2_Alarm: (
        URIRef  # A device that indicates high concentration of carbon dioxide.
    )
    High_Discharge_Air_Temperature_Alarm: (
        URIRef  # An alarm that indicates that discharge air temperature is too high
    )
    High_Head_Pressure_Alarm: URIRef  # An alarm that indicates a high pressure generated on the output side of a gas compressor in a refrigeration or air conditioning system.
    High_Humidity_Alarm: (
        URIRef  # An alarm that indicates high concentration of water vapor in the air.
    )
    High_Humidity_Alarm_Parameter: URIRef  # A parameter determining the humidity level at which to trigger a high humidity alarm
    High_Outside_Air_Lockout_Temperature_Differential_Parameter: (
        URIRef  # The upper bound of the outside air temperature lockout range
    )
    High_Return_Air_Temperature_Alarm: (
        URIRef  # An alarm that indicates that return air temperature is too high
    )
    High_Static_Pressure_Cutout_Setpoint_Limit: URIRef  # A parameter that places a lower or upper bound on the range of permitted values of a High_Static_Pressure_Cutout_Setpoint.
    High_Temperature_Alarm: URIRef  # An alarm that indicates high temperature.
    High_Temperature_Alarm_Parameter: URIRef  # A parameter determining the temperature level at which to trigger a high temperature alarm
    High_Temperature_Hot_Water_Return_Temperature_Sensor: URIRef  # Measures the temperature of high-temperature hot water returned to a hot water system
    High_Temperature_Hot_Water_Supply_Temperature_Sensor: URIRef  # Measures the temperature of high-temperature hot water supplied by a hot water system
    Hold_Status: URIRef
    Hospitality_Box: URIRef  # A room at a stadium, usually overlooking the field of play, that is physical separate from the other seating at the venue
    Hot_Box: URIRef  # hot air chamber forming part of an air handler.
    Hot_Water: URIRef  # Hot water used for HVAC heating or supply to hot taps
    Hot_Water_Baseboard_Radiator: (
        URIRef  # Hydronic heating device located at or near the floor
    )
    Hot_Water_Coil: URIRef  # A heating element typically made of pipe, tube or wire that emits heat that is filled with hot water.
    Hot_Water_Differential_Pressure_Deadband_Setpoint: (
        URIRef  # Sets the size of a deadband of differential pressure of hot water
    )
    Hot_Water_Differential_Pressure_Integral_Time_Parameter: URIRef
    Hot_Water_Differential_Pressure_Load_Shed_Reset_Status: URIRef
    Hot_Water_Differential_Pressure_Load_Shed_Status: URIRef
    Hot_Water_Differential_Pressure_Proportional_Band_Parameter: URIRef
    Hot_Water_Differential_Pressure_Sensor: URIRef  # Measures the difference in water pressure on either side of a hot water valve
    Hot_Water_Differential_Pressure_Setpoint: URIRef  # Sets the target water differential pressure between an upstream and downstream point in a water pipe or conduit used to carry hot water
    Hot_Water_Differential_Temperature_Sensor: URIRef  # Measures the difference in temperature between the entering water to the boiler or other water heating device and leaving water from the same boiler or other water heating device
    Hot_Water_Discharge_Flow_Sensor: (
        URIRef  # Measures the rate of flow of hot discharge water
    )
    Hot_Water_Discharge_Flow_Setpoint: (
        URIRef  # Sets the target flow rate of hot discharge water
    )
    Hot_Water_Discharge_Temperature_Load_Shed_Status: URIRef
    Hot_Water_Flow_Sensor: URIRef  # Measures the rate of flow in a hot water circuit
    Hot_Water_Flow_Setpoint: URIRef  # Sets the target flow rate of hot water
    Hot_Water_Loop: URIRef  # A collection of equipment that transport and regulate hot water among each other
    Hot_Water_Meter: (
        URIRef  # A meter that measures the usage or consumption of hot water
    )
    Hot_Water_Pump: URIRef  # A pump that performs work on hot water; typically part of a hot water system
    Hot_Water_Radiator: URIRef  # Radiator that uses hot water
    Hot_Water_Return_Flow_Sensor: (
        URIRef  # Measures the rate of flow of hot return water
    )
    Hot_Water_Return_Temperature_Sensor: (
        URIRef  # Measures the temperature of water returned to a hot water system
    )
    Hot_Water_Static_Pressure_Setpoint: URIRef  # Sets static pressure of hot air
    Hot_Water_Supply_Flow_Sensor: (
        URIRef  # Measures the rate of flow of hot supply water
    )
    Hot_Water_Supply_Flow_Setpoint: (
        URIRef  # Sets the target flow rate of hot supply water
    )
    Hot_Water_Supply_Temperature_High_Reset_Setpoint: URIRef
    Hot_Water_Supply_Temperature_Load_Shed_Status: URIRef
    Hot_Water_Supply_Temperature_Low_Reset_Setpoint: URIRef
    Hot_Water_Supply_Temperature_Sensor: (
        URIRef  # Measures the temperature of water supplied by a hot water system
    )
    Hot_Water_System: URIRef  # The equipment, devices and conduits that handle the production and distribution of hot water in a building
    Hot_Water_System_Enable_Command: URIRef  # Enables operation of the hot water system
    Hot_Water_Temperature_Setpoint: URIRef  # Sets the temperature of hot water
    Hot_Water_Usage_Sensor: URIRef  # Measures the amount of hot water that is consumed, over some period of time
    Hot_Water_Valve: URIRef  # A valve regulating the flow of hot water
    Humidification_Start_Stop_Status: URIRef
    Humidifier: URIRef  # A device that adds moisture to air or other gases
    Humidifier_Fault_Status: URIRef  # Indicates the presence of a fault in a humidifier
    Humidify_Command: URIRef
    Humidity_Alarm: URIRef  # An alarm that indicates the off-normal conditions associated with the concentration of water vapor in the air.
    Humidity_Parameter: (
        URIRef  # Parameters relevant to humidity-related systems and points
    )
    Humidity_Sensor: URIRef  # Measures the concentration of water vapor in air
    Humidity_Setpoint: URIRef  # Sets humidity
    Humidity_Tolerance_Parameter: URIRef  # A parameter determining the difference between upper and lower limits of humidity.
    IDF: URIRef  # An room for an intermediate distribution frame, where cables carrying signals from the main distribution frame terminate and then feed out to endpoints
    Ice: URIRef  # Water in its solid form
    Ice_Tank_Leaving_Water_Temperature_Sensor: (
        URIRef  # Measures the temperature of water leaving an ice tank
    )
    Illuminance_Sensor: (
        URIRef  # Measures the total luminous flux incident on a surface, per unit area
    )
    Imbalance_Sensor: URIRef  # A sensor which measures difference (imbalance) between phases of an electrical system
    Induction_Unit: URIRef  # A device with an primary air connection and integrated coil and condensate pan that performs sensible and latent cooling of a space. Essentially an Active Chilled Beam with a built in condensate pan.
    Information_Area: URIRef  # An information booth or kiosk where visitors would look for information
    Inside_Face_Surface_Temperature_Sensor: URIRef  # Measures the inside surface (relative to the space) of the radiant panel of the radiant heating and cooling HVAC system.
    Inside_Face_Surface_Temperature_Setpoint: URIRef  # Sets temperature for the inside face surface temperature of the radiant panel.
    Intake_Air_Filter: URIRef  # Filters air intake
    Intake_Air_Temperature_Sensor: (
        URIRef  # Measures air at the interface between the building and the outside
    )
    Integral_Gain_Parameter: URIRef
    Integral_Time_Parameter: URIRef
    Intercom_Equipment: URIRef
    Interface: (
        URIRef  # A device that provides an occupant control over a lighting system
    )
    Intrusion_Detection_Equipment: URIRef
    Inverter: URIRef  # A device that changes direct current into alternating current
    Isolation_Valve: URIRef  # A valve that stops the flow of a fluid, usually for maintenance or safety purposes
    Janitor_Room: (
        URIRef  # A room set aside for the storage of cleaning equipment and supplies
    )
    Jet_Nozzle_Air_Diffuser: URIRef  # An air diffuser that is designed to produce high velocity discharge air stream to throw the air over a large distance or target the air stream to a localize area
    Laboratory: URIRef  # facility acceptable to the local, national, or international recognized authority having jurisdiction and which provides uniform testing and examination procedures and standards for meeting design, manufacturing, and factory testing requirements.
    Laminar_Flow_Air_Diffuser: URIRef  # An air diffuser that is designed for low discharge air speeds to provide uniform and unidirectional air pattern which minimizes room air entrainment
    Last_Fault_Code_Status: URIRef  # Indicates the last fault code that occurred
    Lead_Lag_Command: URIRef  # Enables lead/lag operation
    Lead_Lag_Status: URIRef  # Indicates if lead/lag operation is enabled
    Lead_On_Off_Command: URIRef  # Controls the active/inactive status of the "lead" part of a lead/lag system
    Leak_Alarm: (
        URIRef  # An alarm that indicates leaks occurred in systems containing fluids
    )
    Leaving_Water: URIRef  # Water that is leaving a piece of equipment or system
    Leaving_Water_Flow_Sensor: URIRef  # Measures the rate of flow of water that is leaving a piece of equipment or system
    Leaving_Water_Flow_Setpoint: URIRef  # Sets the target flow rate of leaving water
    Leaving_Water_Temperature_Sensor: URIRef  # Measures the temperature of water leaving a piece of equipment or system
    Leaving_Water_Temperature_Setpoint: URIRef  # Sets temperature of leaving water
    Library: URIRef  # A place for the storage and/or consumption of physical media, e.g. books, periodicals, and DVDs/CDs
    Lighting: URIRef
    Lighting_Equipment: URIRef
    Lighting_System: URIRef  # The equipment, devices and interfaces that serve or are a part of the lighting subsystem in a building
    Lighting_Zone: URIRef
    Limit: URIRef  # A parameter that places an upper or lower bound on the range of permitted values of another point
    Liquid: URIRef  # state of matter intermediate between crystalline substances and gases in which the volume of a substance, but not the shape, remains relatively constant.
    Liquid_CO2: URIRef  # Carbon Dioxide in the liquid phase
    Liquid_Detection_Alarm: URIRef
    Load_Current_Sensor: URIRef  # Measures the current consumed by a load
    Load_Parameter: URIRef
    Load_Setpoint: URIRef
    Load_Shed_Command: (
        URIRef  # Controls load shedding behavior provided by a control system
    )
    Load_Shed_Differential_Pressure_Setpoint: URIRef
    Load_Shed_Setpoint: URIRef
    Load_Shed_Status: URIRef  # Indicates if a load shedding policy is in effect
    Loading_Dock: URIRef  # A part of a facility where delivery trucks can load and unload. Usually partially enclosed with specific traffic lanes leading to the dock
    Lobby: URIRef  # A space just after the entrance to a building or other space of a building, where visitors can wait
    Locally_On_Off_Status: URIRef
    Location: URIRef
    Lockout_Status: URIRef  # Indicates if a piece of equipment, system, or functionality has been locked out from operation
    Lockout_Temperature_Differential_Parameter: URIRef
    Loop: URIRef  # A collection of connected equipment; part of a System
    Lounge: URIRef  # A room for lesiure activities or relaxing
    Louver: URIRef  # Device consisting of an assembly of parallel sloping vanes, intended to permit the passage of air while providing a measure of protection against environmental influences
    Low_Freeze_Protect_Temperature_Parameter: URIRef
    Low_Humidity_Alarm: (
        URIRef  # An alarm that indicates low concentration of water vapor in the air.
    )
    Low_Humidity_Alarm_Parameter: URIRef  # A parameter determining the humidity level at which to trigger a low humidity alarm
    Low_Outside_Air_Lockout_Temperature_Differential_Parameter: (
        URIRef  # The lower bound of the outside air temperature lockout range
    )
    Low_Outside_Air_Temperature_Enable_Differential_Sensor: URIRef
    Low_Outside_Air_Temperature_Enable_Setpoint: URIRef
    Low_Return_Air_Temperature_Alarm: (
        URIRef  # An alarm that indicates that return air temperature is too low
    )
    Low_Suction_Pressure_Alarm: URIRef  # An alarm that indicates a low suction pressure in the compressor in a refrigeration or air conditioning system.
    Low_Temperature_Alarm: URIRef  # An alarm that indicates low temperature.
    Low_Temperature_Alarm_Parameter: URIRef  # A parameter determining the temperature level at which to trigger a low temperature alarm
    Lowest_Exhaust_Air_Static_Pressure_Sensor: URIRef  # The lowest observed static pressure of air in exhaust regions of an HVAC system over some period of time
    Luminaire: URIRef  # A complete lighting unit consisting of a lamp or lamps and ballast(s) (when applicable) together with the parts designed to distribute the light, to position and protect the lamps, and to connect the lamps to the power supply.
    Luminaire_Driver: URIRef  # A power source for a luminaire
    Luminance_Alarm: URIRef
    Luminance_Command: (
        URIRef  # Controls the amount of luminance delivered by a lighting system
    )
    Luminance_Sensor: URIRef  # Measures the luminous intensity per unit area of light travelling in a given direction
    Luminance_Setpoint: URIRef  # Sets luminance
    MAU: URIRef  # See Makeup_Air_Unit
    MDF: URIRef  # A room for the Main Distribution Frame, the central place of a building where cables carrying signals meet and connect to the outside world
    Mail_Room: URIRef  # A room where mail is received and sorted for distribution to the rest of the building
    Maintenance_Mode_Command: URIRef  # Controls whether or not a device or controller is operating in "Maintenance" mode
    Maintenance_Required_Alarm: URIRef  # An alarm that indicates that repair/maintenance is required on an associated device or equipment
    Majlis: URIRef  # In Arab countries, an Majlis is a private lounge where visitors are received and entertained
    Makeup_Air_Unit: URIRef  # A device designed to condition ventilation air introduced into a space or to replace air exhausted from a process or general area exhaust. The device may be used to prevent negative pressure within buildings or to reduce airborne contaminants in a space.
    Makeup_Water: URIRef  # Water used used to makeup water loss through leaks, evaporation, or blowdown
    Makeup_Water_Valve: URIRef  # A valve regulating the flow of makeup water into a water holding tank, e.g. a cooling tower, hot water tank
    Manual_Auto_Status: (
        URIRef  # Indicates if a system is under manual or automatic operation
    )
    Massage_Room: URIRef  # Usually adjunct to an athletic facility, a private/semi-private space where massages are performed
    Max_Air_Flow_Setpoint_Limit: URIRef  # A parameter that places an upper bound on the range of permitted values of a Air_Flow_Setpoint.
    Max_Air_Temperature_Setpoint: URIRef  # Setpoint for maximum air temperature
    Max_Chilled_Water_Differential_Pressure_Setpoint_Limit: URIRef  # A parameter that places an upper bound on the range of permitted values of a Chilled_Water_Differential_Pressure_Setpoint.
    Max_Cooling_Discharge_Air_Flow_Setpoint_Limit: URIRef  # A parameter that places an upper bound on the range of permitted values of a Cooling_Discharge_Air_Flow_Setpoint.
    Max_Cooling_Supply_Air_Flow_Setpoint_Limit: URIRef  # A parameter that places an upper bound on the range of permitted values of a Cooling_Supply_Air_Flow_Setpoint.
    Max_Discharge_Air_Static_Pressure_Setpoint_Limit: URIRef  # A parameter that places an upper bound on the range of permitted values of a Discharge_Air_Static_Pressure_Setpoint.
    Max_Discharge_Air_Temperature_Setpoint_Limit: URIRef  # A parameter that places an upper bound on the range of permitted values of a Discharge_Air_Temperature_Setpoint.
    Max_Frequency_Command: URIRef  # Sets the maximum permitted frequency
    Max_Heating_Discharge_Air_Flow_Setpoint_Limit: URIRef  # A parameter that places an upper bound on the range of permitted values of a Heating_Discharge_Air_Flow_Setpoint.
    Max_Heating_Supply_Air_Flow_Setpoint_Limit: URIRef  # A parameter that places an upper bound on the range of permitted values of a Heating_Supply_Air_Flow_Setpoint.
    Max_Hot_Water_Differential_Pressure_Setpoint_Limit: URIRef  # A parameter that places an upper bound on the range of permitted values of a Hot_Water_Differential_Pressure_Setpoint.
    Max_Limit: URIRef  # A parameter that places an upper bound on the range of permitted values of a Setpoint.
    Max_Load_Setpoint: URIRef
    Max_Occupied_Cooling_Discharge_Air_Flow_Setpoint_Limit: URIRef  # A parameter that places an upper bound on the range of permitted values of a Occupied_Cooling_Discharge_Air_Flow_Setpoint.
    Max_Occupied_Cooling_Supply_Air_Flow_Setpoint_Limit: URIRef  # A parameter that places an upper bound on the range of permitted values of a Occupied_Cooling_Supply_Air_Flow_Setpoint.
    Max_Occupied_Heating_Discharge_Air_Flow_Setpoint_Limit: URIRef  # A parameter that places an upper bound on the range of permitted values of a Occupied_Heating_Discharge_Air_Flow_Setpoint.
    Max_Occupied_Heating_Supply_Air_Flow_Setpoint_Limit: URIRef  # A parameter that places an upper bound on the range of permitted values of a Occupied_Heating_Supply_Air_Flow_Setpoint.
    Max_Position_Setpoint_Limit: URIRef  # A parameter that places an upper bound on the range of permitted values of a Position_Setpoint.
    Max_Speed_Setpoint_Limit: URIRef  # A parameter that places an upper bound on the range of permitted values of a Speed_Setpoint.
    Max_Static_Pressure_Setpoint_Limit: URIRef  # A parameter that places an upper bound on the range of permitted values of a Static_Pressure_Setpoint.
    Max_Supply_Air_Static_Pressure_Setpoint_Limit: URIRef  # A parameter that places an upper bound on the range of permitted values of a Supply_Air_Static_Pressure_Setpoint.
    Max_Temperature_Setpoint_Limit: URIRef  # A parameter that places an upper bound on the range of permitted values of a Temperature_Setpoint.
    Max_Unoccupied_Cooling_Discharge_Air_Flow_Setpoint_Limit: URIRef  # A parameter that places an upper bound on the range of permitted values of a Unoccupied_Cooling_Discharge_Air_Flow_Setpoint.
    Max_Unoccupied_Cooling_Supply_Air_Flow_Setpoint_Limit: URIRef  # A parameter that places an upper bound on the range of permitted values of a Unoccupied_Cooling_Supply_Air_Flow_Setpoint.
    Max_Unoccupied_Heating_Discharge_Air_Flow_Setpoint_Limit: URIRef  # A parameter that places an upper bound on the range of permitted values of a Unoccupied_Heating_Discharge_Air_Flow_Setpoint.
    Max_Unoccupied_Heating_Supply_Air_Flow_Setpoint_Limit: URIRef  # A parameter that places an upper bound on the range of permitted values of a Unoccupied_Heating_Supply_Air_Flow_Setpoint.
    Max_Water_Level_Alarm: (
        URIRef  # Alarm indicating that the maximum water level was reached
    )
    Max_Water_Temperature_Setpoint: URIRef  # Setpoint for max water temperature
    Measurable: URIRef
    Mechanical_Room: (
        URIRef  # A class of service rooms where mechanical equipment (HVAC) operates
    )
    Media_Hot_Desk: URIRef  # A non-enclosed space used by members of the media temporarily to cover an event while they are present at a venue
    Media_Production_Room: URIRef  # A enclosed space used by media professionals for the production of media
    Media_Room: URIRef  # A class of spaces related to the creation of media
    Medical_Room: URIRef  # A class of rooms used for medical purposes
    Medium_Temperature_Hot_Water_Differential_Pressure_Load_Shed_Reset_Status: URIRef
    Medium_Temperature_Hot_Water_Differential_Pressure_Load_Shed_Setpoint: URIRef
    Medium_Temperature_Hot_Water_Differential_Pressure_Load_Shed_Status: URIRef
    Medium_Temperature_Hot_Water_Differential_Pressure_Sensor: URIRef  # Measures the difference in water pressure between sections of a medium temperature hot water system
    Medium_Temperature_Hot_Water_Differential_Pressure_Setpoint: URIRef
    Medium_Temperature_Hot_Water_Discharge_Temperature_High_Reset_Setpoint: URIRef
    Medium_Temperature_Hot_Water_Discharge_Temperature_Low_Reset_Setpoint: URIRef
    Medium_Temperature_Hot_Water_Return_Temperature_Sensor: URIRef  # Measures the temperature of medium-temperature hot water returned to a hot water system
    Medium_Temperature_Hot_Water_Supply_Temperature_High_Reset_Setpoint: URIRef
    Medium_Temperature_Hot_Water_Supply_Temperature_Load_Shed_Setpoint: URIRef
    Medium_Temperature_Hot_Water_Supply_Temperature_Load_Shed_Status: URIRef
    Medium_Temperature_Hot_Water_Supply_Temperature_Low_Reset_Setpoint: URIRef
    Medium_Temperature_Hot_Water_Supply_Temperature_Sensor: URIRef  # Measures the temperature of medium-temperature hot water supplied by a hot water system
    Meter: URIRef  # A device that measure usage or consumption of some media --- typically a form energy or power.
    Methane_Level_Sensor: URIRef  # Measures the concentration of methane in air
    Min_Air_Flow_Setpoint_Limit: URIRef  # A parameter that places a lower bound on the range of permitted values of a Air_Flow_Setpoint.
    Min_Air_Temperature_Setpoint: URIRef  # Setpoint for minimum air temperature
    Min_Chilled_Water_Differential_Pressure_Setpoint_Limit: URIRef  # A parameter that places a lower bound on the range of permitted values of a Chilled_Water_Differential_Pressure_Setpoint.
    Min_Cooling_Discharge_Air_Flow_Setpoint_Limit: URIRef  # A parameter that places a lower bound on the range of permitted values of a Cooling_Discharge_Air_Flow_Setpoint.
    Min_Cooling_Supply_Air_Flow_Setpoint_Limit: URIRef  # A parameter that places a lower bound on the range of permitted values of a Cooling_Supply_Air_Flow_Setpoint.
    Min_Discharge_Air_Static_Pressure_Setpoint_Limit: URIRef  # A parameter that places a lower bound on the range of permitted values of a Discharge_Air_Static_Pressure_Setpoint.
    Min_Discharge_Air_Temperature_Setpoint_Limit: URIRef  # A parameter that places a lower bound on the range of permitted values of a Discharge_Air_Temperature_Setpoint.
    Min_Fresh_Air_Setpoint_Limit: URIRef  # A parameter that places a lower bound on the range of permitted values of a Fresh_Air_Setpoint.
    Min_Heating_Discharge_Air_Flow_Setpoint_Limit: URIRef  # A parameter that places a lower bound on the range of permitted values of a Heating_Discharge_Air_Flow_Setpoint.
    Min_Heating_Supply_Air_Flow_Setpoint_Limit: URIRef  # A parameter that places a lower bound on the range of permitted values of a Heating_Supply_Air_Flow_Setpoint.
    Min_Hot_Water_Differential_Pressure_Setpoint_Limit: URIRef  # A parameter that places a lower bound on the range of permitted values of a Hot_Water_Differential_Pressure_Setpoint.
    Min_Limit: URIRef  # A parameter that places a lower bound on the range of permitted values of a Setpoint.
    Min_Occupied_Cooling_Discharge_Air_Flow_Setpoint_Limit: URIRef  # A parameter that places a lower bound on the range of permitted values of a Occupied_Cooling_Discharge_Air_Flow_Setpoint.
    Min_Occupied_Cooling_Supply_Air_Flow_Setpoint_Limit: URIRef  # A parameter that places a lower bound on the range of permitted values of a Occupied_Cooling_Supply_Air_Flow_Setpoint.
    Min_Occupied_Heating_Discharge_Air_Flow_Setpoint_Limit: URIRef  # A parameter that places a lower bound on the range of permitted values of a Occupied_Heating_Discharge_Air_Flow_Setpoint.
    Min_Occupied_Heating_Supply_Air_Flow_Setpoint_Limit: URIRef  # A parameter that places a lower bound on the range of permitted values of a Occupied_Heating_Supply_Air_Flow_Setpoint.
    Min_Outside_Air_Flow_Setpoint_Limit: URIRef  # A parameter that places a lower bound on the range of permitted values of a Outside_Air_Flow_Setpoint.
    Min_Position_Setpoint_Limit: URIRef  # A parameter that places a lower bound on the range of permitted values of a Position_Setpoint.
    Min_Speed_Setpoint_Limit: URIRef  # A parameter that places a lower bound on the range of permitted values of a Speed_Setpoint.
    Min_Static_Pressure_Setpoint_Limit: URIRef  # A parameter that places a lower bound on the range of permitted values of a Static_Pressure_Setpoint.
    Min_Supply_Air_Static_Pressure_Setpoint_Limit: URIRef  # A parameter that places a lower bound on the range of permitted values of a Supply_Air_Static_Pressure_Setpoint.
    Min_Temperature_Setpoint_Limit: URIRef  # A parameter that places a lower bound on the range of permitted values of a Temperature_Setpoint.
    Min_Unoccupied_Cooling_Discharge_Air_Flow_Setpoint_Limit: URIRef  # A parameter that places a lower bound on the range of permitted values of a Unoccupied_Cooling_Discharge_Air_Flow_Setpoint.
    Min_Unoccupied_Cooling_Supply_Air_Flow_Setpoint_Limit: URIRef  # A parameter that places a lower bound on the range of permitted values of a Unoccupied_Cooling_Supply_Air_Flow_Setpoint.
    Min_Unoccupied_Heating_Discharge_Air_Flow_Setpoint_Limit: URIRef  # A parameter that places a lower bound on the range of permitted values of a Unoccupied_Heating_Discharge_Air_Flow_Setpoint.
    Min_Unoccupied_Heating_Supply_Air_Flow_Setpoint_Limit: URIRef  # A parameter that places a lower bound on the range of permitted values of a Unoccupied_Heating_Supply_Air_Flow_Setpoint.
    Min_Water_Level_Alarm: (
        URIRef  # Alarm indicating that the minimum water level was reached
    )
    Min_Water_Temperature_Setpoint: URIRef  # Setpoint for min water temperature
    Mixed_Air: URIRef  # (1) air that contains two or more streams of air. (2) combined outdoor air and recirculated air.
    Mixed_Air_Filter: URIRef  # A filter that is applied to the mixture of recirculated and outside air
    Mixed_Air_Flow_Sensor: URIRef  # Measures the rate of flow of mixed air
    Mixed_Air_Humidity_Sensor: URIRef  # Measures the humidity of mixed air
    Mixed_Air_Humidity_Setpoint: URIRef  # Humidity setpoint for mixed air
    Mixed_Air_Temperature_Sensor: URIRef  # Measures the temperature of mixed air
    Mixed_Air_Temperature_Setpoint: URIRef  # Sets temperature of mixed air
    Mixed_Damper: URIRef  # A damper that modulates the flow of the mixed outside and return air streams
    Mode_Command: URIRef  # Controls the operating mode of a device or controller
    Mode_Status: (
        URIRef  # Indicates which mode a system, device or control loop is currently in
    )
    Motion_Sensor: URIRef  # Detects the presence of motion in some area
    Motor: URIRef  # A machine in which power is applied to do work by the conversion of various forms of energy into mechanical force and motion.
    Motor_Control_Center: URIRef  # The Motor Control Center is a specialized type of switchgear which provides electrical power to major mechanical systems in the building such as HVAC components.
    Motor_Current_Sensor: URIRef  # Measures the current consumed by a motor
    Motor_Direction_Status: URIRef  # Indicates which direction a motor is operating in, e.g. forward or reverse
    Motor_On_Off_Status: URIRef
    Motor_Speed_Sensor: URIRef
    Motor_Torque_Sensor: URIRef  # Measures the torque, or rotating power, of a motor
    NO2_Level_Sensor: URIRef  # Measures the concentration of NO2 in air
    NVR: URIRef
    Natural_Gas: URIRef  # Fossil fuel energy source consisting largely of methane and other hydrocarbons
    Natural_Gas_Boiler: URIRef  # A closed, pressure vessel that uses natural gas for heating water or other fluids to supply steam or hot water for heating, humidification, or other applications.
    Network_Video_Recorder: URIRef
    No_Water_Alarm: (
        URIRef  # Alarm indicating that there is no water in the equipment or system
    )
    Noncondensing_Natural_Gas_Boiler: URIRef  # A closed, pressure vessel that uses natural gas with no system to capture latent heat for heating water or other fluids to supply steam or hot water for heating, humidification, or other applications.
    Occupancy_Command: URIRef  # Controls whether or not a device or controller is operating in "Occupied" mode
    Occupancy_Sensor: URIRef  # Detects occupancy of some space or area
    Occupancy_Status: URIRef  # Indicates if a room or space is occupied
    Occupied_Air_Temperature_Setpoint: URIRef
    Occupied_Cooling_Discharge_Air_Flow_Setpoint: (
        URIRef  # Sets discharge air flow for cooling when occupied
    )
    Occupied_Cooling_Supply_Air_Flow_Setpoint: (
        URIRef  # Sets supply air flow rate for cooling when occupied
    )
    Occupied_Cooling_Temperature_Deadband_Setpoint: (
        URIRef  # Sets the size of a deadband of temperature for cooling when occupied
    )
    Occupied_Discharge_Air_Flow_Setpoint: (
        URIRef  # Sets discharge air flow when occupied
    )
    Occupied_Discharge_Air_Temperature_Setpoint: URIRef
    Occupied_Heating_Discharge_Air_Flow_Setpoint: (
        URIRef  # Sets discharge air flow for heating when occupied
    )
    Occupied_Heating_Supply_Air_Flow_Setpoint: (
        URIRef  # Sets supply air flow rate for heating when occupied
    )
    Occupied_Heating_Temperature_Deadband_Setpoint: (
        URIRef  # Sets the size of a deadband of temperature for heating when occupied
    )
    Occupied_Mode_Status: (
        URIRef  # Indicates if a system, device or control loop is in "Occupied" mode
    )
    Occupied_Return_Air_Temperature_Setpoint: URIRef
    Occupied_Room_Air_Temperature_Setpoint: URIRef
    Occupied_Supply_Air_Flow_Setpoint: URIRef  # Sets supply air flow rate when occupied
    Occupied_Supply_Air_Temperature_Setpoint: URIRef
    Occupied_Zone_Air_Temperature_Setpoint: URIRef
    Off_Command: URIRef  # An Off Command controls or reports the binary 'off' status of a control loop, relay or equipment activity. It can only be used to stop/deactivate an associated equipment or process, or determine that the related entity is 'off'
    Off_Status: URIRef  # Indicates if a control loop, relay or equipment is off
    Office: URIRef  # A class of rooms dedicated for work or study
    Office_Kitchen: URIRef  # A common space, usually near or in a breakroom, where minor food preparation occurs
    Oil: URIRef  # a viscous liquid derived from petroleum, especially for use as a fuel or lubricant.
    On_Command: URIRef  # An On Command controls or reports the binary 'on' status of a control loop, relay or equipment activity. It can only be used to start/activate an associated equipment or process, or determine that the related entity is 'on'
    On_Off_Command: URIRef  # An On/Off Command controls or reports the binary status of a control loop, relay or equipment activity
    On_Off_Status: (
        URIRef  # Indicates the on/off status of a control loop, relay or equipment
    )
    On_Status: URIRef  # Indicates if a control loop, relay or equipment is on
    On_Timer_Sensor: URIRef  # Measures the duration for which a device was in an active or "on" state
    Open_Close_Status: (
        URIRef  # Indicates the open/close status of a device such as a damper or valve
    )
    Open_Heating_Valve_Outside_Air_Temperature_Setpoint: URIRef
    Open_Office: URIRef  # An open space used for work or study by multiple people. Usuaully subdivided into cubicles or desks
    Operating_Mode_Status: URIRef  # Indicates the current operating mode of a system, device or control loop
    Outdoor_Area: URIRef  # A class of spaces that exist outside of a building
    Output_Frequency_Sensor: URIRef
    Output_Voltage_Sensor: (
        URIRef  # Measures the voltage output by some process or device
    )
    Outside: URIRef
    Outside_Air: URIRef  # air external to a defined zone (e.g., corridors).
    Outside_Air_CO2_Sensor: URIRef  # Measures the concentration of CO2 in outside air
    Outside_Air_CO_Sensor: URIRef  # Measures the concentration of CO in outside air
    Outside_Air_Dewpoint_Sensor: (
        URIRef  # Senses the dewpoint temperature of outside air
    )
    Outside_Air_Enthalpy_Sensor: (
        URIRef  # Measures the total heat content of outside air
    )
    Outside_Air_Flow_Sensor: (
        URIRef  # Measures the rate of flow of outside air into the system
    )
    Outside_Air_Flow_Setpoint: URIRef  # Sets outside air flow rate
    Outside_Air_Grains_Sensor: URIRef  # Measures the mass of water vapor in outside air
    Outside_Air_Humidity_Sensor: URIRef  # Measures the relative humidity of outside air
    Outside_Air_Humidity_Setpoint: URIRef  # Humidity setpoint for outside air
    Outside_Air_Lockout_Temperature_Differential_Parameter: URIRef
    Outside_Air_Lockout_Temperature_Setpoint: URIRef
    Outside_Air_Temperature_Enable_Differential_Sensor: URIRef
    Outside_Air_Temperature_High_Reset_Setpoint: URIRef
    Outside_Air_Temperature_Low_Reset_Setpoint: URIRef
    Outside_Air_Temperature_Sensor: URIRef  # Measures the temperature of outside air
    Outside_Air_Temperature_Setpoint: URIRef  # Sets temperature of outside air
    Outside_Air_Wet_Bulb_Temperature_Sensor: (
        URIRef  # A sensor measuring the wet-bulb temperature of outside air
    )
    Outside_Damper: URIRef  # A damper that modulates the flow of outside air
    Outside_Face_Surface_Temperature_Sensor: URIRef  # Measures the outside surface (relative to the space) of the radiant panel of a radiant heating and cooling HVAC system.
    Outside_Face_Surface_Temperature_Setpoint: URIRef  # Sets temperature for the outside face surface temperature of the radiant panel.
    Outside_Illuminance_Sensor: (
        URIRef  # Measures the total luminous flux incident on an outside, per unit area
    )
    Overload_Alarm: (
        URIRef  # An alarm that can indicate when a full-load current is exceeded.
    )
    Overridden_Off_Status: URIRef  # Indicates if a control loop, relay or equipment has been turned off when it would otherwise be scheduled to be on
    Overridden_On_Status: URIRef  # Indicates if a control loop, relay or equipment has been turned on when it would otherwise be scheduled to be off
    Overridden_Status: URIRef  # Indicates if the expected operating status of an equipment or control loop has been overridden
    Override_Command: URIRef  # Controls or reports whether or not a device or control loop is in 'override'
    Ozone_Level_Sensor: URIRef  # Measures the concentration of ozone in air
    PAU: URIRef  # A type of AHU, use to pre-treat the outdoor air before feed to AHU
    PID_Parameter: URIRef
    PIR_Sensor: URIRef  # Detects the presence of motion in some area using the differential change in infrared intensity between two or more receptors
    PM10_Level_Sensor: URIRef  # Detects level of particulates of size 10 microns
    PM10_Sensor: URIRef  # Detects matter of size 10 microns
    PM1_Level_Sensor: URIRef  # Detects level of particulates of size 1 microns
    PM1_Sensor: URIRef  # Detects matter of size 1 micron
    PVT_Panel: URIRef  # A type of solar panels that convert solar radiation into usable thermal and electrical energy
    PV_Array: URIRef
    PV_Current_Output_Sensor: URIRef  # See Photovoltaic_Current_Output_Sensor
    PV_Generation_System: (
        URIRef  # A collection of photovoltaic devices that generates energy
    )
    PV_Panel: URIRef  # An integrated assembly of interconnected photovoltaic cells designed to deliver a selected level of working voltage and current at its output terminals packaged for protection against environment degradation and suited for incorporation in photovoltaic power systems.
    Parameter: URIRef  # Parameter points are configuration settings used to guide the operation of equipment and control systems; for example they may provide bounds on valid setpoint values
    Parking_Level: URIRef  # A floor of a parking structure
    Parking_Space: URIRef  # An area large enough to park an individual vehicle
    Parking_Structure: (
        URIRef  # A building or part of a building devoted to vehicle parking
    )
    Particulate_Matter_Sensor: URIRef  # Detects pollutants in the ambient air
    Passive_Chilled_Beam: URIRef  # A chilled beam that does not have an integral air supply and instead relies on natural convection to draw air through the device.
    Peak_Power_Demand_Sensor: (
        URIRef  # The peak power consumed by a process over some period of time
    )
    Photovoltaic_Array: URIRef  # A collection of photovoltaic panels
    Photovoltaic_Current_Output_Sensor: URIRef  # Senses the amperes of electrical current produced as output by a photovoltaic device
    Piezoelectric_Sensor: URIRef  # Senses changes pressure, acceleration, temperature, force or strain via the piezoelectric effect
    PlugStrip: URIRef  # A device containing a block of electrical sockets allowing multiple electrical devices to be powered from a single electrical socket.
    Plumbing_Room: URIRef  # A service room devoted to the operation and routing of water in a building. Usually distinct from the HVAC subsystems.
    Point: URIRef
    Portfolio: URIRef  # A collection of sites
    Position_Command: URIRef  # Controls or reports the position of some object
    Position_Limit: URIRef  # A parameter that places a lower or upper bound on the range of permitted values of a Position_Setpoint.
    Position_Sensor: URIRef  # Measures the current position of a component in terms of a fraction of its full range of motion
    Potable_Water: URIRef  # Water that is safe to drink
    Power_Alarm: URIRef  # An alarm that indicates the off-normal conditions associated with electrical power.
    Power_Loss_Alarm: URIRef  # An alarm that indicates a power failure.
    Power_Sensor: URIRef  # Measures the amount of instantaneous power consumed
    Prayer_Room: URIRef  # A room set aside for prayer
    Pre_Filter: URIRef  # A filter installed in front of a more efficient filter to extend the life of the more expensive higher efficiency filter
    Pre_Filter_Status: URIRef  # Indicates if a prefilter needs to be replaced
    Preheat_Demand_Setpoint: URIRef  # Sets the rate required for preheat
    Preheat_Discharge_Air_Temperature_Sensor: (
        URIRef  # Measures the temperature of discharge air before heating is applied
    )
    Preheat_Hot_Water_System: URIRef
    Preheat_Hot_Water_Valve: URIRef
    Preheat_Supply_Air_Temperature_Sensor: (
        URIRef  # Measures the temperature of supply air before it is heated
    )
    Pressure_Alarm: URIRef  # An alarm that indicates the off-normal conditions associated with pressure.
    Pressure_Sensor: URIRef  # Measure the amount of force acting on a unit area
    Pressure_Setpoint: URIRef  # Sets pressure
    Pressure_Status: URIRef  # Indicates if pressure is within expected bounds
    Private_Office: (
        URIRef  # An office devoted to a single individual, with walls and door
    )
    Proportional_Band_Parameter: URIRef
    Proportional_Gain_Parameter: URIRef
    Pump: URIRef  # Machine for imparting energy to a fluid, causing it to do work, drawing a fluid into itself through an entrance port, and forcing the fluid out through an exhaust port.
    Pump_Command: URIRef  # Controls or reports the speed of a pump (typically as a proportion of its full pumping capacity)
    Pump_On_Off_Status: URIRef
    Pump_Room: URIRef  # A mechanical room that houses pumps
    Pump_VFD: URIRef  # Variable-frequency drive for pumps
    Quantity: URIRef
    RC_Panel: URIRef  # See Radiant_Ceiling_Panel
    RTU: URIRef  # see Rooftop_Unit
    RVAV: URIRef  # See Variable_Air_Volume_Box_With_Reheat
    Radiant_Ceiling_Panel: URIRef  # Radiant panel heating and cooling system that are usually made from metal and suspended under the ceiling or insulated from the building structure.
    Radiant_Panel: URIRef  # A temperature-controlled surface that provides fifty percent (50%) or more of the design heat transfer by thermal radiation.
    Radiant_Panel_Temperature_Sensor: URIRef  # Measures the temperature of the radiant panel of the radiant heating and cooling HVAC system.
    Radiant_Panel_Temperature_Setpoint: URIRef  # Sets temperature of radiant panel.
    Radiation_Hot_Water_System: URIRef
    Radiator: URIRef  # Heat exchangers designed to transfer thermal energy from one medium to another
    Radioactivity_Concentration_Sensor: (
        URIRef  # Measures the concentration of radioactivity
    )
    Radon_Concentration_Sensor: (
        URIRef  # Measures the concentration of radioactivity due to radon
    )
    Rain_Duration_Sensor: (
        URIRef  # Measures the duration of precipitation within some time frame
    )
    Rain_Sensor: URIRef  # Measures the amount of precipitation fallen
    Rated_Speed_Setpoint: URIRef  # Sets rated speed
    Reactive_Power_Sensor: URIRef  # Measures the portion of power that, averaged over a complete cycle of the AC waveform, is due to stored energy which returns to the source in each cycle
    Reception: URIRef  # A space, usually in a lobby, where visitors to a building or space can go to after arriving at a building and inform building staff that they have arrived
    Region: URIRef  # A unit of geographic space, usually contiguous or somehow related to a geopolitical feature
    Reheat_Hot_Water_System: URIRef
    Reheat_Valve: URIRef  # A valve that controls air temperature by modulating the amount of hot water flowing through a reheat coil
    Relative_Humidity_Sensor: URIRef  # Measures the present state of absolute humidity relative to a maximum humidity given the same temperature
    Relief_Damper: URIRef  # A damper that is a component of a Relief Air System, ensuring building doesn't become over-pressurised
    Relief_Fan: URIRef  # A fan that is a component of a Relief Air System, ensuring building doesn't become over-pressurised
    Remotely_On_Off_Status: URIRef
    Reset_Command: (
        URIRef  # Commands that reset a flag, property or value to its default
    )
    Reset_Setpoint: URIRef  # Setpoints used in reset strategies
    Rest_Room: URIRef  # A room that provides toilets and washbowls. Alternate spelling of Restroom
    Restroom: URIRef  # A room that provides toilets and washbowls.
    Retail_Room: URIRef  # A space set aside for retail in a larger establishment, e.g. a gift shop in a hospital
    Return_Air: URIRef  # air removed from a space to be recirculated or exhausted. Air extracted from a space and totally or partially returned to an air conditioner, furnace, or other heating, cooling, or ventilating system.
    Return_Air_CO2_Sensor: URIRef  # Measures the concentration of CO2 in return air
    Return_Air_CO2_Setpoint: URIRef  # Sets some property of CO2 in Return Air
    Return_Air_CO_Sensor: URIRef  # Measures the concentration of CO in return air
    Return_Air_Dewpoint_Sensor: URIRef  # Senses the dewpoint temperature of return air
    Return_Air_Differential_Pressure_Sensor: (
        URIRef  # Measures the difference in pressure between the return and supply side
    )
    Return_Air_Differential_Pressure_Setpoint: URIRef  # Sets the target air differential pressure between an upstream and downstream point in a return air duct or conduit
    Return_Air_Enthalpy_Sensor: URIRef  # Measures the total heat content of return air
    Return_Air_Filter: URIRef  # Filters return air
    Return_Air_Flow_Sensor: URIRef  # Measures the rate of flow of return air
    Return_Air_Grains_Sensor: URIRef  # Measures the mass of water vapor in return air
    Return_Air_Humidity_Sensor: URIRef  # Measures the relative humidity of return air
    Return_Air_Humidity_Setpoint: URIRef  # Humidity setpoint for return air
    Return_Air_Plenum: URIRef  # A component of the HVAC the receives air from the room to recirculate or exhaust to or from the building
    Return_Air_Temperature_Alarm: URIRef  # An alarm that indicates the off-normal conditions associated with the temperature of return air.
    Return_Air_Temperature_High_Reset_Setpoint: URIRef
    Return_Air_Temperature_Low_Reset_Setpoint: URIRef
    Return_Air_Temperature_Sensor: URIRef  # Measures the temperature of return air
    Return_Air_Temperature_Setpoint: URIRef  # The target temperature for return air, often used as an approximation of zone air temperature
    Return_Chilled_Water_Temperature_Setpoint: URIRef  # Sets the temperature of return (downstream of the chilled water load) chilled water
    Return_Condenser_Water: URIRef  # In a condenser water loop, this is water being brought away from the condenser side of a heat-rejection device (e.g. chiller). It is the 'warm' side.
    Return_Condenser_Water_Flow_Sensor: (
        URIRef  # Measures the flow of the return condenser water
    )
    Return_Condenser_Water_Temperature_Sensor: (
        URIRef  # Measures the temperature of the return condenser water
    )
    Return_Condenser_Water_Temperature_Setpoint: (
        URIRef  # The temperature setpoint for the return condenser water
    )
    Return_Damper: URIRef  # A damper that modulates the flow of return air
    Return_Fan: URIRef  # Fan moving return air -- air that is circulated from the building back into the HVAC system
    Return_Heating_Valve: (
        URIRef  # A valve installed on the return side of a heat exchanger
    )
    Return_Hot_Water: URIRef
    Return_Hot_Water_Temperature_Setpoint: URIRef  # Sets the temperature of return (downstream of the hot water load) hot water
    Return_Water: (
        URIRef  # The water is a system after it is used in a heat transfer cycle
    )
    Return_Water_Flow_Sensor: URIRef
    Return_Water_Temperature_Sensor: URIRef  # Measures the temperature of return water
    Return_Water_Temperature_Setpoint: URIRef  # Sets the temperature of return water
    Riser: URIRef  # A vertical shaft indented for installing building infrastructure e.g., electrical wire, network communication wire, plumbing, etc
    Rooftop: URIRef
    Rooftop_Unit: URIRef  # Packaged air conditioner mounted on a roof, the conditioned air being discharged directly into the rooms below or through a duct system.
    Room: URIRef  # Base class for all more specific room types.
    Room_Air_Temperature_Setpoint: URIRef  # Sets temperature of room air
    Run_Enable_Command: URIRef
    Run_Request_Status: (
        URIRef  # Indicates if a request has been filed to start a device or equipment
    )
    Run_Status: URIRef
    Run_Time_Sensor: URIRef  # Measures the duration for which a device was in an active or "on" state
    Safety_Equipment: URIRef
    Safety_Shower: URIRef
    Safety_System: URIRef
    Sash_Position_Sensor: URIRef  # Measures the current position of a sash in terms of the percent of fully open
    Schedule_Temperature_Setpoint: (
        URIRef  # The current setpoint as indicated by the schedule
    )
    Security_Equipment: URIRef
    Security_Service_Room: (
        URIRef  # A class of spaces used by the security staff of a facility
    )
    Sensor: URIRef  # A Sensor is an input point that represents the value of a device or instrument designed to detect and measure a variable (ASHRAE Dictionary).
    Server_Room: URIRef
    Service_Room: URIRef  # A class of spaces related to the operations of building subsystems, e.g. HVAC, electrical, IT, plumbing, etc
    Setpoint: (
        URIRef  # A Setpoint is an input value at which the desired property is set
    )
    Shading_System: URIRef  # Devices that can control daylighting through various means
    Shared_Office: URIRef  # An office used by multiple people
    Short_Cycle_Alarm: URIRef  # An alarm that indicates a short cycle occurred. A short cycle occurs when a cooling cycle is prevented from completing its full cycle
    Shower: URIRef  # A space containing showers, usually adjacent to an athletic or execise area
    Site: URIRef  # A geographic region containing 0 or more buildings. Typically used as the encapsulating location for a collection of Brick entities through the hasSite/isSiteOf relationships
    Smoke_Alarm: URIRef  # An alarm that indicates the off-normal conditions associated with smoke.
    Smoke_Detection_Alarm: URIRef
    Solar_Azimuth_Angle_Sensor: URIRef  # Measures the azimuth angle of the sun
    Solar_Radiance_Sensor: URIRef  # The amount of light that passes through or is emitted from the sun and falls within a given solid angle in a specified direction
    Solar_Thermal_Collector: URIRef  # A type of solar panels that converts solar radiation into thermal energy.
    Solar_Zenith_Angle_Sensor: URIRef  # Measures the zenith angle of the sun
    Solid: URIRef  # one of the three states or phases of matter characterized by stability of dimensions, relative incompressibility, and molecular motion held to limited oscillation.
    Space: URIRef  # A part of the physical world or a virtual world whose 3D spatial extent is bounded actually or theoretically, and provides for certain functions within the zone it is contained in.
    Space_Heater: URIRef  # A heater used to warm the air in an enclosed area, such as a room or office
    Speed_Reset_Command: URIRef
    Speed_Sensor: URIRef  # Measures the magnitude of velocity of some form of movement
    Speed_Setpoint: URIRef  # Sets speed
    Speed_Setpoint_Limit: URIRef  # A parameter that places a lower or upper bound on the range of permitted values of a Speed_Setpoint.
    Speed_Status: (
        URIRef  # Indicates the operating speed of a device or equipment, e.g. fan
    )
    Sports_Service_Room: URIRef  # A class of spaces used in the support of sports
    Stage_Enable_Command: URIRef  # A point representing a discrete stage which the equipment should be operating at. The desired stage number should be identified by an entity property
    Stage_Riser: URIRef  # A low platform in a space or on a stage
    Stages_Status: URIRef  # Indicates which stage a control loop or equipment is in
    Staircase: URIRef  # A vertical space containing stairs
    Standby_CRAC: URIRef  # A CRAC that is activated as part of a lead/lag operation or when an alarm occurs in a primary unit
    Standby_Fan: URIRef  # Fan that is activated as part of a lead/lag operation or when a primary fan raises an alarm
    Standby_Glycool_Unit_On_Off_Status: (
        URIRef  # Indicates the on/off status of a standby glycool unit
    )
    Standby_Load_Shed_Command: URIRef
    Standby_Unit_On_Off_Status: URIRef  # Indicates the on/off status of a standby unit
    Start_Stop_Command: URIRef  # A Start/Stop Command controls or reports the active/inactive status of a control sequence
    Start_Stop_Status: URIRef  # Indicates the active/inactive status of a control loop (but not equipment activities or relays -- use On/Off for this purpose)
    Static_Pressure_Deadband_Setpoint: (
        URIRef  # Sets the size of a deadband of static pressure
    )
    Static_Pressure_Integral_Time_Parameter: URIRef
    Static_Pressure_Proportional_Band_Parameter: URIRef
    Static_Pressure_Sensor: URIRef  # Measures resistance to airflow in a heating and cooling system's components and duct work
    Static_Pressure_Setpoint: URIRef  # Sets static pressure
    Static_Pressure_Setpoint_Limit: URIRef  # A parameter that places a lower or upper bound on the range of permitted values of a Static_Pressure_Setpoint.
    Static_Pressure_Step_Parameter: URIRef
    Status: URIRef  # A Status is input point that reports the current operating mode, state, position, or condition of an item. Statuses are observations and should be considered 'read-only'
    Steam: URIRef  # water in the vapor phase.
    Steam_Baseboard_Radiator: (
        URIRef  # Steam heating device located at or near the floor
    )
    Steam_Distribution: URIRef  # Utilize a steam distribution source to represent how steam is distributed across multiple destinations
    Steam_On_Off_Command: URIRef
    Steam_Radiator: URIRef  # Radiator that uses steam
    Steam_System: URIRef  # The equipment, devices and conduits that handle the production and distribution of steam in a building
    Steam_Usage_Sensor: URIRef  # Measures the amount of steam that is consumed or used, over some period of time
    Steam_Valve: URIRef
    Step_Parameter: URIRef
    Storage_Room: URIRef  # A class of spaces used for storage
    Storey: URIRef
    Studio: URIRef  # A room used for the production or media, usually with either a specialized set or a specialized sound booth for recording
    Substance: URIRef
    Supply_Air: URIRef  # (1) air delivered by mechanical or natural ventilation to a space, composed of any combination of outdoor air, recirculated air, or transfer air. (2) air entering a space from an air-conditioning, heating, or ventilating apparatus for the purpose of comfort conditioning. Supply air is generally filtered, fan forced, and either heated, cooled, humidified, or dehumidified as necessary to maintain specified conditions. Only the quantity of outdoor air within the supply airflow may be used as replacement air.
    Supply_Air_Differential_Pressure_Sensor: URIRef  # Measures the difference in pressure between an upstream and downstream of an air duct or other air conduit used to supply air into the building
    Supply_Air_Differential_Pressure_Setpoint: URIRef  # Sets the target air differential pressure between an upstream and downstream point in a supply air duct or conduit
    Supply_Air_Duct_Pressure_Status: (
        URIRef  # Indicates if air pressure in supply duct is within expected bounds
    )
    Supply_Air_Flow_Demand_Setpoint: (
        URIRef  # Sets the rate of supply air flow required for a process
    )
    Supply_Air_Flow_Sensor: URIRef  # Measures the rate of flow of supply air
    Supply_Air_Flow_Setpoint: URIRef  # Sets supply air flow rate
    Supply_Air_Humidity_Sensor: URIRef  # Measures the relative humidity of supply air
    Supply_Air_Humidity_Setpoint: URIRef  # Humidity setpoint for supply air
    Supply_Air_Integral_Gain_Parameter: URIRef
    Supply_Air_Plenum: URIRef  # A component of the HVAC the receives air from the air handling unit to distribute to the building
    Supply_Air_Proportional_Gain_Parameter: URIRef
    Supply_Air_Static_Pressure_Deadband_Setpoint: (
        URIRef  # Sets the size of a deadband of static pressure of supply air
    )
    Supply_Air_Static_Pressure_Integral_Time_Parameter: URIRef
    Supply_Air_Static_Pressure_Proportional_Band_Parameter: URIRef
    Supply_Air_Static_Pressure_Sensor: (
        URIRef  # The static pressure of air within supply regions of an HVAC system
    )
    Supply_Air_Static_Pressure_Setpoint: URIRef  # Sets static pressure of supply air
    Supply_Air_Temperature_Alarm: URIRef  # An alarm that indicates the off-normal conditions associated with the temperature of supply air.
    Supply_Air_Temperature_Deadband_Setpoint: (
        URIRef  # Sets the size of a deadband of temperature of supply air
    )
    Supply_Air_Temperature_High_Reset_Setpoint: URIRef
    Supply_Air_Temperature_Low_Reset_Setpoint: URIRef
    Supply_Air_Temperature_Proportional_Band_Parameter: URIRef
    Supply_Air_Temperature_Reset_Differential_Setpoint: URIRef
    Supply_Air_Temperature_Sensor: URIRef  # Measures the temperature of supply air
    Supply_Air_Temperature_Setpoint: URIRef  # Temperature setpoint for supply air
    Supply_Air_Temperature_Step_Parameter: URIRef
    Supply_Air_Velocity_Pressure_Sensor: URIRef
    Supply_Chilled_Water: URIRef
    Supply_Chilled_Water_Temperature_Setpoint: (
        URIRef  # Temperature setpoint for supply chilled water
    )
    Supply_Condenser_Water: URIRef  # In a condenser water loop, this is water being brought to the condenser side of a heat-rejection device (e.g. chiller). It is the 'cold' side.
    Supply_Condenser_Water_Flow_Sensor: (
        URIRef  # Measures the flow of the supply condenser water
    )
    Supply_Condenser_Water_Temperature_Sensor: (
        URIRef  # Measures the temperature of the supply condenser water
    )
    Supply_Condenser_Water_Temperature_Setpoint: (
        URIRef  # The temperature setpoint for the supply condenser water
    )
    Supply_Fan: URIRef  # Fan moving supply air -- air that is supplied from the HVAC system into the building
    Supply_Hot_Water: URIRef
    Supply_Hot_Water_Temperature_Setpoint: (
        URIRef  # Temperature setpoint for supply hot water
    )
    Supply_Water: URIRef
    Supply_Water_Differential_Pressure_Deadband_Setpoint: (
        URIRef  # Sets the size of a deadband of differential pressure of supply water
    )
    Supply_Water_Differential_Pressure_Integral_Time_Parameter: URIRef
    Supply_Water_Differential_Pressure_Proportional_Band_Parameter: URIRef
    Supply_Water_Flow_Sensor: URIRef  # Measures the rate of flow of hot supply water
    Supply_Water_Flow_Setpoint: URIRef  # Sets the flow rate of hot supply water
    Supply_Water_Temperature_Alarm: URIRef  # An alarm that indicates the off-normal conditions associated with temperature of the supply water.
    Supply_Water_Temperature_Deadband_Setpoint: (
        URIRef  # Sets the size of a deadband of temperature of supply water
    )
    Supply_Water_Temperature_Integral_Time_Parameter: URIRef
    Supply_Water_Temperature_Proportional_Band_Parameter: URIRef
    Supply_Water_Temperature_Setpoint: URIRef  # Sets temperature of supply water
    Surveillance_Camera: URIRef
    Switch: URIRef  # A switch used to operate all or part of a lighting installation
    Switch_Room: URIRef  # A telecommuncations room housing network switches
    Switchgear: URIRef  # A main disconnect or service disconnect feeds power to a switchgear, which then distributes power to the rest of the building through smaller amperage-rated disconnects.
    System: URIRef  # A System is a combination of equipment and auxiliary devices (e.g., controls, accessories, interconnecting means, and termi­nal elements) by which energy is transformed so it performs a specific function such as HVAC, service water heating, or lighting. (ASHRAE Dictionary).
    System_Enable_Command: URIRef  # Enables operation of a system
    System_Shutdown_Status: URIRef  # Indicates if a system has been shutdown
    System_Status: URIRef  # Indicates properties of the activity of a system
    TABS_Panel: URIRef  # See Thermally_Activated_Building_System_Panel
    TETRA_Room: URIRef  # A room used for local two-way radio networks, e.g. the portable radios carried by facilities staff
    TVOC_Level_Sensor: URIRef  # A sensor measuring the level of all VOCs in air
    TVOC_Sensor: URIRef
    Team_Room: URIRef  # An office used by multiple team members for specific work tasks. Distinct from Conference Room
    Telecom_Room: (
        URIRef  # A class of spaces used to support telecommuncations and IT equipment
    )
    Temperature_Alarm: URIRef  # An alarm that indicates the off-normal conditions associated with temperature.
    Temperature_Deadband_Setpoint: URIRef  # Sets the size of a deadband of temperature
    Temperature_Differential_Reset_Setpoint: URIRef
    Temperature_High_Reset_Setpoint: URIRef
    Temperature_Low_Reset_Setpoint: URIRef
    Temperature_Parameter: (
        URIRef  # Parameters relevant to temperature-related systems and points
    )
    Temperature_Sensor: URIRef  # Measures temperature: the physical property of matter that quantitatively expresses the common notions of hot and cold
    Temperature_Setpoint: URIRef  # Sets temperature
    Temperature_Step_Parameter: URIRef
    Temperature_Tolerance_Parameter: URIRef  # A parameter determining the difference between upper and lower limits of temperature.
    Temporary_Occupancy_Status: URIRef  # For systems that differentiate between scheduled occupied/unoccupied mode, this indicates if a space is temporarily occupied when it would otherwise be unoccupied
    Terminal_Unit: URIRef  # A device that regulates the volumetric flow rate and/or the temperature of the controlled medium.
    Thermal_Power_Meter: URIRef  # A standalone thermal power meter
    Thermal_Power_Sensor: URIRef
    Thermally_Activated_Building_System_Panel: URIRef  # Radiant panel heating and cooling system where the energy heat source or sink is embedded in the building structure such as in slabs and walls.
    Thermostat: URIRef  # An automatic control device used to maintain temperature at a fixed or adjustable setpoint.
    Ticketing_Booth: URIRef  # A room or space used to sell or distribute tickets to events at a venue
    Time_Parameter: URIRef
    Time_Setpoint: URIRef
    Tolerance_Parameter: URIRef  # difference between upper and lower limits of size for a given nominal dimension or value.
    Torque_Sensor: URIRef  # Measures torque, the tendency of a force to rotate an object about some axis
    Touchpanel: URIRef  # A switch used to operate all or part of a lighting installation that uses a touch-based mechanism (typically resistive or capacitive) rather than a mechanical actuator
    Trace_Heat_Sensor: URIRef  # Measures the surface temperature of pipelines carrying temperature-sensitive products; typically used to avoid frosting/freezing
    Transformer: URIRef  # A Transformer is usually fed by a high-voltage source and then steps down the voltage to a lower-voltage feed for low-voltage application (such as lights). Transformers also can step up voltage, but this generally does not apply to in building distribution.
    Transformer_Room: URIRef  # An electrical room where electricity enters and is transformed to different voltages and currents by the equipment contained in the room
    Tunnel: URIRef  # An enclosed space that connects buildings. Often underground
    Underfloor_Air_Plenum: URIRef  # An open space between a structural concrete slab and the underside of a raised access floor system that connects to an air handling unit to receive conditioned and/or ventilating air before delivery to the room(s)
    Underfloor_Air_Plenum_Static_Pressure_Sensor: URIRef  # Measures the outward push of air against the plenum surfaces and used to measure the resistance when air moves through the plenum
    Underfloor_Air_Plenum_Static_Pressure_Setpoint: (
        URIRef  # Sets the underfloor air plenum static pressure
    )
    Underfloor_Air_Temperature_Sensor: (
        URIRef  # Measures the temperature of underfloor air
    )
    Unit_Failure_Alarm: (
        URIRef  # An alarm that indicates the failure of an equipment or device
    )
    Unoccupied_Air_Temperature_Cooling_Setpoint: (
        URIRef  # Sets temperature of air when unoccupied for cooling
    )
    Unoccupied_Air_Temperature_Heating_Setpoint: (
        URIRef  # Sets temperature of air when unoccupied for heating
    )
    Unoccupied_Air_Temperature_Setpoint: (
        URIRef  # Sets temperature of air when unoccupied
    )
    Unoccupied_Cooling_Discharge_Air_Flow_Setpoint: (
        URIRef  # Sets discharge air flow for cooling when unoccupied
    )
    Unoccupied_Discharge_Air_Temperature_Setpoint: URIRef
    Unoccupied_Load_Shed_Command: URIRef
    Unoccupied_Return_Air_Temperature_Setpoint: URIRef
    Unoccupied_Room_Air_Temperature_Setpoint: URIRef
    Unoccupied_Supply_Air_Temperature_Setpoint: URIRef
    Unoccupied_Zone_Air_Temperature_Setpoint: URIRef
    Usage_Sensor: URIRef  # Measures the amount of some substance that is consumed or used, over some period of time
    VAV: URIRef  # See Variable_Air_Volume_Box
    VFD: URIRef  # Electronic device that varies its output frequency to vary the rotating speed of a motor, given a fixed input frequency. Used with fans or pumps to vary the flow in the system as a function of a maintained pressure.
    VFD_Enable_Command: URIRef  # Enables operation of a variable frequency drive
    Valve: URIRef  # A device that regulates, directs or controls the flow of a fluid by opening, closing or partially obstructing various passageways
    Valve_Command: URIRef  # Controls or reports the openness of a valve (typically as a proportion of its full range of motion)
    Valve_Position_Sensor: URIRef  # Measures the current position of a valve in terms of the percent of fully open
    Variable_Air_Volume_Box: URIRef  # A device that regulates the volume and temperature of air delivered to a zone by opening or closing a damper
    Variable_Air_Volume_Box_With_Reheat: URIRef  # A VAV box with a reheat coil mounted on the discharge end of the unit that can heat the air delivered to a zone
    Variable_Frequency_Drive: URIRef  # Electronic device that varies its output frequency to vary the rotating speed of a motor, given a fixed input frequency. Used with fans or pumps to vary the flow in the system as a function of a maintained pressure.
    Velocity_Pressure_Sensor: (
        URIRef  # Measures the difference between total pressure and static pressure
    )
    Velocity_Pressure_Setpoint: URIRef  # Sets static veloicty pressure
    Vent_Operating_Mode_Status: URIRef  # Indicates the current operating mode of a vent
    Ventilation_Air_Flow_Ratio_Limit: URIRef  # A parameter that places a lower or upper bound on the range of permitted values of a Ventilation_Air_Flow_Ratio_Setpoint.
    Ventilation_Air_System: URIRef  # The equipment, devices, and conduits that handle the introduction and distribution of ventilation air in the building
    Vertical_Space: (
        URIRef  # A class of spaces used to connect multiple floors or levels..
    )
    Video_Intercom: URIRef
    Video_Surveillance_Equipment: URIRef
    Visitor_Lobby: URIRef  # A lobby for visitors to the building. Sometimes used to distinguish from an employee entrance looby
    Voltage_Imbalance_Sensor: URIRef  # A sensor which measures the voltage difference (imbalance) between phases of an electrical system
    Voltage_Sensor: URIRef  # Measures the voltage of an electrical device or object
    Wardrobe: URIRef  # Storage for clothing, costumes, or uniforms
    Warm_Cool_Adjust_Sensor: URIRef  # User provided adjustment of zone temperature, typically in the range of +/- 5 degrees
    Warmest_Zone_Air_Temperature_Sensor: URIRef  # The zone temperature that is warmest; drives the supply temperature of cold air. A computed value rather than a physical sensor. Also referred to as a 'Highest Zone Air Temperature Sensor'
    Waste_Storage: URIRef  # A room used for storing waste such as trash or recycling
    Water: URIRef  # transparent, odorless, tasteless liquid; a compound of hydrogen and oxygen (H2O), containing 11.188% hydrogen and 88.812% oxygen by mass; freezing at 32°F (0°C); boiling near 212°F (100°C).
    Water_Alarm: URIRef  # Alarm that indicates an undesirable event with a pipe, container, or equipment carrying water e.g. water leak
    Water_Differential_Pressure_Setpoint: URIRef  # Sets the target water differential pressure between an upstream and downstream point in a water pipe or conduit
    Water_Differential_Temperature_Sensor: URIRef  # Measures the difference in water temperature between an upstream and downstream point in a pipe or conduit
    Water_Differential_Temperature_Setpoint: URIRef  # Sets the target differential temperature between the start and end of a heat transfer cycle in a water circuit
    Water_Distribution: URIRef  # Utilize a water distribution source to represent how water is distributed across multiple destinations (pipes)
    Water_Flow_Sensor: URIRef  # Measures the rate of flow of water
    Water_Flow_Setpoint: URIRef  # Sets the target flow rate of water
    Water_Heater: URIRef  # An apparatus for heating and usually storing hot water
    Water_Level_Alarm: (
        URIRef  # An alarm that indicates a high or low water level e.g. in a basin
    )
    Water_Level_Sensor: URIRef  # Measures the height/level of water in some container
    Water_Loop: URIRef  # A collection of equipment that transport and regulate water among each other
    Water_Loss_Alarm: (
        URIRef  # An alarm that indicates a loss of water e.g. during transport
    )
    Water_Meter: URIRef  # A meter that measures the usage or consumption of water
    Water_Pump: URIRef  # A pump that performs work on water
    Water_System: URIRef  # The equipment, devices and conduits that handle the production and distribution of water in a building
    Water_Tank: URIRef  # A space used to hold water
    Water_Temperature_Alarm: URIRef  # An alarm that indicates the off-normal conditions associated with temperature of water.
    Water_Temperature_Sensor: URIRef  # Measures the temperature of water
    Water_Temperature_Setpoint: URIRef  # Sets temperature of water
    Water_Usage_Sensor: URIRef  # Measures the amount of water that is consumed, over some period of time
    Water_Valve: URIRef  # A valve that modulates the flow of water
    Weather_Station: URIRef  # A dedicated weather measurement station
    Wind_Direction_Sensor: (
        URIRef  # Measures the direction of wind in degrees relative to North
    )
    Wind_Speed_Sensor: (
        URIRef  # Measured speed of wind, caused by air moving from high to low pressure
    )
    Wing: URIRef  # A wing is part of a building – or any feature of a building – that is subordinate to the main, central structure.
    Workshop: URIRef  # A space used to house equipment that can be used to repair or fabricate things
    Zone: URIRef  # (1) a separately controlled heated or cooled space. (2) one occupied space or several occupied spaces with similar occupancy category, occupant density, zone air distribution effectiveness, and zone primary airflow per unit area. (3) space or group of spaces within a building for which the heating, cooling, or lighting requirements are sufficiently similar that desired conditions can be maintained throughout by a single controlling device.
    Zone_Air: URIRef  # air inside a defined zone (e.g., corridors).
    Zone_Air_Cooling_Temperature_Setpoint: (
        URIRef  # The upper (cooling) setpoint for zone air temperature
    )
    Zone_Air_Dewpoint_Sensor: URIRef  # Measures dewpoint of zone air
    Zone_Air_Heating_Temperature_Setpoint: (
        URIRef  # The lower (heating) setpoint for zone air temperature
    )
    Zone_Air_Humidity_Sensor: URIRef  # Measures the relative humidity of zone air
    Zone_Air_Humidity_Setpoint: URIRef  # Humidity setpoint for zone air
    Zone_Air_Temperature_Sensor: URIRef  # Measures the temperature of air in a zone
    Zone_Air_Temperature_Setpoint: URIRef  # Sets temperature of zone air
    Zone_Standby_Load_Shed_Command: URIRef
    Zone_Unoccupied_Load_Shed_Command: URIRef

    # http://www.w3.org/2002/07/owl#Property
    feeds: URIRef  # The subject is upstream of the object in the context of some sequential process; some media is passed between them
    feedsAir: URIRef  # Passes air
    hasAddress: URIRef  # To specify the address of a building.
    hasAssociatedTag: URIRef  # The class is associated with the given tag
    hasInputSubstance: URIRef  # The subject receives the given substance as an input to its internal process
    hasLocation: (
        URIRef  # Subject is physically located in the location given by the object
    )
    hasOutputSubstance: URIRef  # The subject produces or exports the given substance from its internal process
    hasPart: URIRef  # The subject is composed in part of the entity given by the object
    hasPoint: URIRef  # The subject has a source of telemetry identified by the object. In some systems the source of telemetry may be represented as a digital/analog input/output point
    hasQUDTReference: URIRef  # Points to the relevant QUDT definition
    hasTag: URIRef  # The subject has the given tag
    hasTimeseriesId: URIRef  # The unique identifier (primary key) for this TimeseriesReference in some database
    hasUnit: URIRef  # The QUDT unit associated with this Brick entity (usually a Brick Point instance or Entity Property)
    isAssociatedWith: URIRef  # The tag is associated with the given class
    isFedBy: URIRef
    isLocationOf: URIRef  # Subject is the physical location encapsulating the object
    isMeasuredBy: URIRef
    isPartOf: URIRef
    isPointOf: URIRef  # The subject is a source of telemetry related to the object. In some systems the source of telemetry may be represented as a digital/analog input/output point
    isRegulatedBy: URIRef
    isTagOf: URIRef
    latitude: URIRef
    longitude: URIRef
    measures: URIRef  # The subject measures a quantity or substance given by the object
    regulates: URIRef  # The subject contributes to or performs the regulation of the substance given by the object
    storedAt: (
        URIRef  # A reference to where the data for this TimeseriesReference is stored
    )
    timeseries: URIRef  # Relates a Brick point to the TimeseriesReference that indicates where and how the data for this point is stored
    value: URIRef  # The basic value of an entity property

    # https://brickschema.org/schema/Brick#EntityProperty
    aggregate: URIRef  # Description of how the dta for this point is aggregated
    area: URIRef  # Entity has 2-dimensional area
    azimuth: URIRef  # (Horizontal) angle between a projected vector and a reference vector (typically a compass bearing). The projected vector usually indicates the direction of a face or plane.
    buildingPrimaryFunction: URIRef  # Enumerated string applied to a site record to indicate the building's primary function. The list of primary functions is derived from the US Energy Star program (adopted from Project Haystack)
    buildingThermalTransmittance: URIRef  # The area-weighted average heat transfer coefficient (commonly referred to as a U-value) for a building envelope
    conversionEfficiency: URIRef  # The percent efficiency of the conversion process (usually to power or energy) carried out by the entity
    coolingCapacity: URIRef  # Measurement of a chiller ability to remove heat (adopted from Project Haystack)
    coordinates: URIRef  # The location of an entity in latitude/longitude
    currentFlowType: URIRef  # The current flow type of the entity
    electricalPhaseCount: URIRef  # Entity has these phases
    electricalPhases: URIRef  # Entity has these electrical AC phases
    grossArea: URIRef  # Entity has gross 2-dimensional area
    measuredModuleConversionEfficiency: URIRef  # The measured percentage of sunlight that is converted into usable power
    measuredPowerOutput: URIRef  # The nominal measured power output of the entity
    netArea: URIRef  # Entity has net 2-dimensional area
    operationalStage: URIRef  # The associated operational stage
    operationalStageCount: (
        URIRef  # The number of operational stages supported by this eqiupment
    )
    panelArea: URIRef  # Surface area of a panel, such as a PV panel
    powerComplexity: URIRef  # Entity has this power complexity
    powerFlow: URIRef  # Entity has this power flow relative to the building'
    ratedModuleConversionEfficiency: URIRef  # The *rated* percentage of sunlight that is converted into usable power, as measured using Standard Test Conditions (STC): 1000 W/sqm irradiance, 25 degC panel temperature, no wind
    ratedPowerOutput: URIRef  # The nominal rated power output of the entity
    temperatureCoefficientofPmax: URIRef  # The % change in power output for every degree celsius that the entity is hotter than 25 degrees celsius
    thermalTransmittance: URIRef  # The area-weighted average heat transfer coefficient (commonly referred to as a U-value)
    tilt: URIRef  # The direction an entity is facing in degrees above the horizon
    volume: URIRef  # Entity has 3-dimensional volume
    yearBuilt: URIRef  # Four digit year that a building was first built. (adopted from Project Haystack)

    _extras = ["PM2.5_Sensor", "PM2.5_Level_Sensor"]

    _NS = Namespace("https://brickschema.org/schema/Brick#")
